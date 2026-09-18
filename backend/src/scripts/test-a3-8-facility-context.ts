import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { a38Fixtures, createChecker, resolveRaw } from './support/a3-8-fixtures.ts'

// Audit F05-B — the A3.8 half of F05. A3.8 must consume the one shared facility-profile resolver
// (zero/one/many), fail closed on missing or ambiguous context BEFORE rule-version matching, the
// historical path or any REFERENCE_ONLY success, and never return a clean REFERENCE_ONLY answer
// for a facility whose regulatory profile is in a different jurisdiction from the rule.

const { check, eq, section, finish } = createChecker('a3.8-facility')

const tag = `A38F-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const otherOrganizationId = process.env.A1_IT_OTHER_ORGANIZATION_ID
const businessDate = '2026-10-15'

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.8-facility] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  // A REFERENCE_ONLY rule and an executable rule, both with an all-null applicability row, so they
  // match every context — the case REF-02 names: "no match with all-null rule applicability".
  const refRule = await fx.makeRule('reference')
  const refVersion = await fx.makeRuleVersion(refRule.id, '1', { effectType: 'REFERENCE_ONLY' })
  await fx.makeApplicability(refVersion.id)

  const execRule = await fx.makeRule('executable')
  const execVersion = await fx.makeRuleVersion(execRule.id, '1')
  await fx.makeApplicability(execVersion.id)
  const execSource = await fx.attachSource(execVersion.id, 'exec-source')

  const matching = await fx.facility('dubai')
  await fx.profile(matching.id, '2026-01-01', null, 'AE-DU')

  const mismatched = await fx.facility('abu-dhabi')
  await fx.profile(mismatched.id, '2026-01-01', null, 'AE-AZ')

  const unprofiled = await fx.facility('no-profile')
  // A profile that exists but is not in force on businessDate must not count.
  await fx.profile(unprofiled.id, '2025-01-01', '2025-12-31', 'AE-DU')

  const ambiguous = await fx.facility('two-profiles')
  // Two overlapping ACTIVE rows are only reachable as legacy data now (F05-A blocks creating them
  // through the service), so they are inserted directly — exactly the case findFirst used to hide.
  const legacyA = await fx.profile(ambiguous.id, '2026-01-01', null, 'AE-DU')
  const legacyB = await fx.profile(ambiguous.id, '2026-03-01', null, 'AE-DU')

  const auditBefore = await prisma.auditEvent.count()

  section('Generic resolution without a facility is unchanged')
  {
    const ref = await resolveRaw(refRule.id, businessDate, {})
    check('REFERENCE_ONLY rule, no facility: REFERENCE_ONLY', ref.ok && ref.value.resolutionStatus === 'REFERENCE_ONLY', JSON.stringify(ref))
    const exec = await resolveRaw(execRule.id, businessDate, {})
    check(
      'executable rule, no facility: RESOLVED to its source',
      exec.ok && exec.value.resolutionStatus === 'RESOLVED' && exec.value.governingSourceVersionId === execSource.sourceVersion.id,
      JSON.stringify(exec),
    )
  }

  section('Exactly one profile in the rule jurisdiction resolves normally')
  {
    const ref = await resolveRaw(refRule.id, businessDate, { facilityId: matching.id })
    check('REFERENCE_ONLY rule, matching facility: clean REFERENCE_ONLY', ref.ok && ref.value.resolutionStatus === 'REFERENCE_ONLY' && ref.value.blockers.length === 0, JSON.stringify(ref))
    const exec = await resolveRaw(execRule.id, businessDate, { facilityId: matching.id })
    check('executable rule, matching facility: RESOLVED', exec.ok && exec.value.resolutionStatus === 'RESOLVED', JSON.stringify(exec))
  }

  section('F05-B: a conflicting facility jurisdiction never yields a clean REFERENCE_ONLY')
  {
    const ref = await resolveRaw(refRule.id, businessDate, { facilityId: mismatched.id })
    check(
      'REFERENCE_ONLY rule in an AE-AZ facility is NOT a clean REFERENCE_ONLY (the counterexample)',
      ref.ok && ref.value.resolutionStatus !== 'REFERENCE_ONLY',
      JSON.stringify(ref.ok ? { status: ref.value.resolutionStatus, blockers: ref.value.blockers } : ref),
    )
    check(
      'it is blocked with the existing A3.7 code JURISDICTION_INCOMPATIBLE',
      ref.ok && ref.value.resolutionStatus === 'BLOCKED_EXECUTABILITY' && ref.value.blockers.join(',') === 'JURISDICTION_INCOMPATIBLE',
      JSON.stringify(ref),
    )
    check(
      'no winner is manufactured',
      ref.ok && ref.value.governingBindingId === null && ref.value.governingSourceVersionId === null,
    )

    const exec = await resolveRaw(execRule.id, businessDate, { facilityId: mismatched.id })
    check(
      'the same mismatch on an executable rule gives the same outcome — one condition, one answer',
      exec.ok && exec.value.resolutionStatus === 'BLOCKED_EXECUTABILITY' && exec.value.blockers.includes('JURISDICTION_INCOMPATIBLE'),
      JSON.stringify(exec.ok ? { status: exec.value.resolutionStatus, blockers: exec.value.blockers } : exec),
    )
    check('and never resolves a winner either', exec.ok && exec.value.governingSourceVersionId === null)
  }

  section('Missing context fails closed before any rule-version matching or REFERENCE_ONLY')
  {
    for (const [label, ruleId] of [
      ['REFERENCE_ONLY rule', refRule.id],
      ['executable rule', execRule.id],
    ] as const) {
      const outcome = await resolveRaw(ruleId, businessDate, { facilityId: unprofiled.id })
      check(
        `${label}, facility with no profile in force: VALIDATION_ERROR, not a result`,
        !outcome.ok && outcome.code === 'VALIDATION_ERROR' && /no ACTIVE regulatory profile/.test(outcome.message),
        JSON.stringify(outcome),
      )
    }
  }

  section('Ambiguous context (two matching profiles) fails closed — no row is picked')
  {
    for (const [label, ruleId] of [
      ['REFERENCE_ONLY rule', refRule.id],
      ['executable rule', execRule.id],
    ] as const) {
      const outcome = await resolveRaw(ruleId, businessDate, { facilityId: ambiguous.id })
      check(
        `${label}, two ACTIVE profiles: VALIDATION_ERROR naming the ambiguity`,
        !outcome.ok && outcome.code === 'VALIDATION_ERROR' && /more than one ACTIVE regulatory profile/.test(outcome.message),
        JSON.stringify(outcome),
      )
    }
  }

  section('Coherence still runs first, so an unknown or foreign facility keeps its 404/403')
  {
    const unknown = await resolveRaw(refRule.id, businessDate, { facilityId: '00000000-0000-4000-8000-000000000000' })
    eq('unknown facility: NOT_FOUND, not a missing-profile error', unknown.ok ? 'ok' : unknown.code, 'NOT_FOUND')
    if (otherOrganizationId) {
      const foreign = await fx.facility('foreign', otherOrganizationId)
      await fx.profile(foreign.id, '2026-01-01', null, 'AE-DU')
      const outcome = await resolveRaw(refRule.id, businessDate, { facilityId: foreign.id })
      eq('foreign facility: FORBIDDEN, even though it has a valid profile', outcome.ok ? 'ok' : outcome.code, 'FORBIDDEN')
    } else {
      console.log('  SKIP  foreign facility (A1_IT_OTHER_ORGANIZATION_ID not set)')
    }
  }

  section('Resolution is read-only')
  check('no AuditEvent was written by any resolution above', (await prisma.auditEvent.count()) === auditBefore)

  // Leave no overlapping ACTIVE pair behind. Both legacy rows are withdrawn; neither is promoted
  // to "the correct one".
  await prisma.facilityRegulatoryProfile.updateMany({ where: { id: { in: [legacyA.id, legacyB.id] } }, data: { status: 'INACTIVE' } })

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.8-facility] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
