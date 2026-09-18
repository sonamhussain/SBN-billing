import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import {
  activateFacilityRegulatoryProfile,
  createFacilityRegulatoryProfile,
  updateFacilityRegulatoryProfile,
} from '../modules/facility-regulatory/facility-regulatory.service.ts'
import { resolveFacilityRegulatoryProfileForDate } from '../modules/facility-regulatory/facility-regulatory.repository.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'

// Audit F05 / C17-C20 — facility regulatory validity must survive every route: one-time finite
// closure of an ACTIVE period, no reopen/extension/second close, explicit zero/one/many profile
// resolution that fails closed (never findFirst), and a single facility-level lock shared by
// activation and update, proven with deterministic barriers against real PostgreSQL.

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

function section(title: string) {
  console.log(`\n[a3-facility] ${title}`)
}

const tag = `A3FP-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const otherOrganizationId = process.env.A1_IT_OTHER_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function day(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

function context(facilityId: string | null): Record<ApplicabilityDimensionKeyV2, unknown> {
  const out = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) out[key] = null
  out.facilityId = facilityId
  return out
}

type Barrier = { promise: Promise<void>; open: () => void }
function barrier(): Barrier {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

// Deterministic "the other transaction is now blocked on a lock" signal — observed in PostgreSQL
// itself, not guessed with a sleep. Resolves as soon as a backend in this database is waiting on a
// lock, or as soon as `settled` completes (the unprotected case, where nothing blocks).
async function waitUntilBlockedOrSettled(settled: Promise<unknown>, timeoutMs = 10_000): Promise<'blocked' | 'settled'> {
  let done = false
  settled.then(
    () => (done = true),
    () => (done = true),
  )
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (done) return 'settled'
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) return 'blocked'
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('neither blocked nor settled within the timeout')
}

async function overlappingActivePairs(facilityId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ pairs: bigint }[]>`
    SELECT count(*) AS pairs
    FROM facility_regulatory_profiles a
    JOIN facility_regulatory_profiles b ON a.facility_id = b.facility_id AND a.id < b.id
    WHERE a.facility_id = ${facilityId}::uuid AND a.status = 'ACTIVE' AND b.status = 'ACTIVE'
      AND a.effective_from <= coalesce(b.effective_to, 'infinity'::date)
      AND b.effective_from <= coalesce(a.effective_to, 'infinity'::date)`
  return Number(rows[0].pairs)
}

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3-facility] run tag ${tag} — organization ${org}`)

  async function facility(name: string, owner = org) {
    return prisma.facility.create({ data: { organizationId: owner, name: `${tag} ${name}` } })
  }

  async function activeProfile(facilityId: string, from: string, to: string | null, jurisdiction = 'AE-DU') {
    const created = await createFacilityRegulatoryProfile(facilityId, jurisdiction, 'DHA', from, to, actor)
    if (!created.ok) throw new Error(`fixture create failed: ${created.message}`)
    const activated = await activateFacilityRegulatoryProfile(created.value.id, actor)
    if (!activated.ok) throw new Error(`fixture activate failed: ${activated.message}`)
    return activated.value.id
  }

  async function inactiveProfile(facilityId: string, from: string, to: string | null) {
    const created = await createFacilityRegulatoryProfile(facilityId, 'AE-DU', 'DHA', from, to, actor)
    if (!created.ok) throw new Error(`fixture create failed: ${created.message}`)
    return created.value.id
  }

  // Runs an update that must be rejected and proves nothing changed.
  async function expectUpdateRejected(label: string, profileId: string, from: unknown, to: unknown, jurisdiction?: unknown) {
    const before = await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: profileId } })
    const auditBefore = await prisma.auditEvent.count()
    const result = await updateFacilityRegulatoryProfile(profileId, jurisdiction, undefined, from, to, actor)
    const after = await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: profileId } })
    const auditAfter = await prisma.auditEvent.count()
    check(`${label}: rejected`, !result.ok && result.code === 'VALIDATION_ERROR', JSON.stringify(result))
    check(
      `${label}: stored row unchanged`,
      before.updatedAt.getTime() === after.updatedAt.getTime() && day(before.effectiveTo) === day(after.effectiveTo) && before.status === after.status,
      `(effectiveTo ${day(before.effectiveTo)} -> ${day(after.effectiveTo)})`,
    )
    check(`${label}: no AuditEvent written`, auditAfter === auditBefore, `(before ${auditBefore}, after ${auditAfter})`)
  }

  // ---- C17 ---------------------------------------------------------------------------------
  section('C17 one-time finite closure of an open ACTIVE period')
  const fClose = await facility('closure')
  const openId = await activeProfile(fClose.id, '2026-01-01', null)
  const auditBefore = await prisma.auditEvent.count()
  const closed = await updateFacilityRegulatoryProfile(openId, undefined, undefined, undefined, '2026-06-30', actor)
  check('C17 closing the open ACTIVE period succeeds', closed.ok && closed.value.effectiveTo === '2026-06-30', JSON.stringify(closed))
  check('C17 exactly one AuditEvent is written', (await prisma.auditEvent.count()) === auditBefore + 1)
  const closureAudit = await prisma.auditEvent.findFirst({
    where: { entityId: openId, actionCode: 'facility_regulatory_profile.updated' },
    orderBy: { occurredAt: 'desc' },
  })
  const beforeState = closureAudit?.beforeState as { effectiveTo?: string | null; status?: string } | null
  const afterState = closureAudit?.afterState as { effectiveTo?: string | null; status?: string } | null
  check('C17 audit beforeState records the open period', beforeState?.effectiveTo === null && beforeState?.status === 'ACTIVE', JSON.stringify(beforeState))
  check('C17 audit afterState records the closure date', afterState?.effectiveTo === '2026-06-30', JSON.stringify(afterState))

  // ---- C18 ---------------------------------------------------------------------------------
  section('C18 reopen / extend / close again / shorten are rejected')
  await expectUpdateRejected('C18 reopen (effectiveTo null)', openId, undefined, null)
  await expectUpdateRejected('C18 extend (2026-12-31)', openId, undefined, '2026-12-31')
  await expectUpdateRejected('C18 close again with the same date', openId, undefined, '2026-06-30')
  await expectUpdateRejected('C18 shorten (2026-03-31)', openId, undefined, '2026-03-31')
  await expectUpdateRejected('C18 ACTIVE jurisdiction edit', openId, undefined, undefined, 'AE-AZ')
  await expectUpdateRejected('C18 ACTIVE update without effectiveTo', openId, '2026-02-01', undefined)

  const successorId = await activeProfile(fClose.id, '2026-07-01', null)
  check('C18 a successor starting after the closure activates', typeof successorId === 'string')
  await expectUpdateRejected('C18 report counterexample: reopen A while B is ACTIVE from July', openId, undefined, null)
  check('C18 no overlapping ACTIVE periods for the facility', (await overlappingActivePairs(fClose.id)) === 0)

  const finiteId = await activeProfile((await facility('finite')).id, '2026-01-01', '2026-12-31')
  await expectUpdateRejected('C18 a period activated as finite cannot be revised', finiteId, undefined, '2026-06-30')

  // ---- C19 ---------------------------------------------------------------------------------
  section('C19 explicit facility resolves to exactly one profile or fails closed')
  const rule = await prisma.ruleDefinition.create({
    data: { organizationId: org, ruleKey: `${tag}-rule`, displayName: 'Facility rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
  })
  const wildcardVersion = await prisma.ruleVersion.create({
    data: { ruleId: rule.id, version: '1', effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT', effectiveFrom: d('2020-01-01'), verificationStatus: 'VERIFIED', verifiedAt: new Date() },
  })
  await prisma.ruleApplicability.create({ data: { ruleVersionId: wildcardVersion.id } })
  const referenceRule = await prisma.ruleDefinition.create({
    data: { organizationId: org, ruleKey: `${tag}-ref`, displayName: 'Facility reference rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
  })
  const referenceVersion = await prisma.ruleVersion.create({
    data: { ruleId: referenceRule.id, version: '1', effectType: 'REFERENCE_ONLY', effectiveFrom: d('2020-01-01'), verificationStatus: 'VERIFIED', verifiedAt: new Date() },
  })
  await prisma.ruleApplicability.create({ data: { ruleVersionId: referenceVersion.id } })

  const noProfile = await facility('no-profile')
  const zero = await evaluateExecutability(wildcardVersion.id, '2026-05-01', context(noProfile.id))
  check('C19 zero profiles + all-null applicability: fails closed', !zero.ok && zero.code === 'VALIDATION_ERROR' && /no ACTIVE regulatory profile/.test(zero.message), JSON.stringify(zero))
  const zeroReference = await evaluateExecutability(referenceVersion.id, '2026-05-01', context(noProfile.id))
  check('C19 zero profiles fails closed before a REFERENCE_ONLY success', !zeroReference.ok && zeroReference.code === 'VALIDATION_ERROR', JSON.stringify(zeroReference))
  const notCovering = await evaluateExecutability(wildcardVersion.id, '2025-06-01', context(fClose.id))
  check('C19 profiles exist but none covers the date: fails closed', !notCovering.ok && notCovering.code === 'VALIDATION_ERROR' && /no ACTIVE regulatory profile/.test(notCovering.message), JSON.stringify(notCovering))

  const exactlyOne = await evaluateExecutability(wildcardVersion.id, '2026-05-01', context(fClose.id))
  check('C19 exactly one covering profile: evaluation proceeds', exactlyOne.ok, JSON.stringify(exactlyOne))
  const generic = await evaluateExecutability(wildcardVersion.id, '2026-05-01', context(null))
  check('C19 omitting facilityId remains a valid generic evaluation', generic.ok, JSON.stringify(generic))

  const ambiguous = await facility('ambiguous')
  // Simulated legacy corruption, written directly (bypassing the service guards) to prove the
  // resolver never hides it. Neutralised again below so no overlapping ACTIVE rows are left behind.
  const legacyA = await prisma.facilityRegulatoryProfile.create({
    data: { facilityId: ambiguous.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: d('2026-01-01'), status: 'ACTIVE' },
  })
  const legacyB = await prisma.facilityRegulatoryProfile.create({
    data: { facilityId: ambiguous.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: d('2026-03-01'), status: 'ACTIVE' },
  })
  try {
    const resolution = await resolveFacilityRegulatoryProfileForDate(ambiguous.id, d('2026-05-01'))
    check(
      'C19 resolver reports "many" with both IDs instead of picking one',
      resolution.kind === 'many' && resolution.profileIds.includes(legacyA.id) && resolution.profileIds.includes(legacyB.id),
      JSON.stringify(resolution),
    )
    const many = await evaluateExecutability(wildcardVersion.id, '2026-05-01', context(ambiguous.id))
    check('C19 two covering profiles: fails closed', !many.ok && many.code === 'VALIDATION_ERROR' && /more than one/.test(many.message), JSON.stringify(many))
    const manyReference = await evaluateExecutability(referenceVersion.id, '2026-05-01', context(ambiguous.id))
    check('C19 two covering profiles fails closed before a REFERENCE_ONLY success', !manyReference.ok, JSON.stringify(manyReference))
  } finally {
    await prisma.facilityRegulatoryProfile.updateMany({ where: { facilityId: ambiguous.id }, data: { status: 'INACTIVE' } })
  }

  const wrongJurisdiction = await facility('wrong-jurisdiction')
  await activeProfile(wrongJurisdiction.id, '2026-01-01', null, 'AE-AZ')
  const wrongReference = await evaluateExecutability(referenceVersion.id, '2026-05-01', context(wrongJurisdiction.id))
  check(
    'C15 (A3.7 part) REFERENCE_ONLY with a wrong-jurisdiction facility is not a clean result',
    wrongReference.ok && wrongReference.value.gateStatus === 'REFERENCE_ONLY' && wrongReference.value.blockers.includes('JURISDICTION_INCOMPATIBLE'),
    JSON.stringify(wrongReference),
  )

  const unknownFacility = await evaluateExecutability(wildcardVersion.id, '2026-05-01', context('11111111-1111-4111-8111-111111111111'))
  check('C19 an unknown facility is still NOT_FOUND (checked before profile resolution)', !unknownFacility.ok && unknownFacility.code === 'NOT_FOUND', JSON.stringify(unknownFacility))
  if (otherOrganizationId) {
    const foreign = await facility('foreign', otherOrganizationId)
    const foreignResult = await evaluateExecutability(wildcardVersion.id, '2026-05-01', context(foreign.id))
    check('C19 a foreign facility is still FORBIDDEN (checked before profile resolution)', !foreignResult.ok && foreignResult.code === 'FORBIDDEN', JSON.stringify(foreignResult))
  }

  // ---- C20 ---------------------------------------------------------------------------------
  section('C20 concurrent edit / close versus activation (deterministic barriers)')

  // (a) INACTIVE-period edit racing activation of the same profile. Unprotected, the edit reads
  // INACTIVE, the activation commits, and the edit then moves an ACTIVE period into overlap.
  {
    const f = await facility('race-edit')
    await activeProfile(f.id, '2027-01-01', '2027-06-30')
    const target = await inactiveProfile(f.id, '2027-07-01', null)
    const holding = barrier()
    const release = barrier()
    const auditBeforeRace = await prisma.auditEvent.count()
    const edit = updateFacilityRegulatoryProfile(target, undefined, undefined, '2027-03-01', undefined, actor, {
      afterLockedRead: async () => {
        holding.open()
        await release.promise
      },
    })
    await holding.promise
    const activation = activateFacilityRegulatoryProfile(target, actor)
    const state = await waitUntilBlockedOrSettled(activation)
    release.open()
    const [editResult, activationResult] = await Promise.all([edit, activation])
    const stored = await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: target } })
    const successes = [editResult.ok, activationResult.ok].filter(Boolean).length
    check('C20a the activation waited on the facility lock', state === 'blocked', `(observed: ${state})`)
    check('C20a no overlapping ACTIVE periods after the race', (await overlappingActivePairs(f.id)) === 0)
    check(
      'C20a outcome is the legal serial one: edit committed, activation rejected for overlap',
      editResult.ok && !activationResult.ok && stored.status === 'INACTIVE' && day(stored.effectiveFrom) === '2027-03-01',
      JSON.stringify({ editResult: editResult.ok, activationResult, status: stored.status, from: day(stored.effectiveFrom) }),
    )
    check('C20a one AuditEvent per committed write, none for the rejection', (await prisma.auditEvent.count()) === auditBeforeRace + successes)
  }

  // (b) Closure of an open ACTIVE profile racing activation of its successor.
  {
    const f = await facility('race-close')
    const open = await activeProfile(f.id, '2028-01-01', null)
    const successor = await inactiveProfile(f.id, '2028-07-01', null)
    const holding = barrier()
    const release = barrier()
    const close = updateFacilityRegulatoryProfile(open, undefined, undefined, undefined, '2028-06-30', actor, {
      afterLockedRead: async () => {
        holding.open()
        await release.promise
      },
    })
    await holding.promise
    const activation = activateFacilityRegulatoryProfile(successor, actor)
    const state = await waitUntilBlockedOrSettled(activation)
    release.open()
    const [closeResult, activationResult] = await Promise.all([close, activation])
    check('C20b the activation waited on the facility lock', state === 'blocked', `(observed: ${state})`)
    check('C20b both succeed in serial order: closure, then successor activation', closeResult.ok && activationResult.ok, JSON.stringify({ closeResult, activationResult }))
    check('C20b no overlapping ACTIVE periods after the race', (await overlappingActivePairs(f.id)) === 0)
  }

  // (c) Two overlapping activations racing each other.
  {
    const f = await facility('race-activate')
    const first = await inactiveProfile(f.id, '2029-01-01', null)
    const second = await inactiveProfile(f.id, '2029-06-01', null)
    const holding = barrier()
    const release = barrier()
    const firstActivation = activateFacilityRegulatoryProfile(first, actor, {
      afterLockedRead: async () => {
        holding.open()
        await release.promise
      },
    })
    await holding.promise
    const secondActivation = activateFacilityRegulatoryProfile(second, actor)
    const state = await waitUntilBlockedOrSettled(secondActivation)
    release.open()
    const [a, b] = await Promise.all([firstActivation, secondActivation])
    check('C20c the second activation waited on the facility lock', state === 'blocked', `(observed: ${state})`)
    check('C20c exactly one of two overlapping activations commits', [a.ok, b.ok].filter(Boolean).length === 1, JSON.stringify({ a, b }))
    check('C20c no overlapping ACTIVE periods after the race', (await overlappingActivePairs(f.id)) === 0)
  }

  // Resolution is read-only.
  const auditBeforeRead = await prisma.auditEvent.count()
  const rowsBeforeRead = await prisma.facilityRegulatoryProfile.count()
  await resolveFacilityRegulatoryProfileForDate(fClose.id, d('2026-05-01'))
  await evaluateExecutability(wildcardVersion.id, '2026-05-01', context(fClose.id))
  check(
    'profile resolution and evaluation write nothing',
    (await prisma.auditEvent.count()) === auditBeforeRead && (await prisma.facilityRegulatoryProfile.count()) === rowsBeforeRead,
  )

  console.log(`\n[a3-facility] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-facility] ALL CHECKS PASS' : '[a3-facility] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-facility] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
