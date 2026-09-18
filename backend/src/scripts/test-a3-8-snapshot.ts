import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../shared/testing/concurrency-probe.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'
import { a38Fixtures, createChecker, d, resolveRaw } from './support/a3-8-fixtures.ts'

// Audit F04 — one read snapshot per evaluation. For each scenario the request is paused at an
// internal stage boundary, a governance change is COMMITTED by another connection, and the request
// is then released. The paused response must equal the state the request started in (one
// consistent state), never a mixture of before-state and after-state reads. A fresh request after
// the change proves the change was real. No sleeps: the pause is an explicit barrier.

const { check, section, finish } = createChecker('a3.8-snapshot')

const tag = `A38S-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const businessDate = '2026-03-15'

function barrier() {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function emptyContext(): Record<ApplicabilityDimensionKeyV2, unknown> {
  const context = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) context[key] = null
  return context
}

// The concurrent change must commit WHILE the reader is paused. A read snapshot takes no row
// locks, so the writer must never wait on the reader; if it did, this would time out instead of
// deadlocking the test.
async function commitWithin<T>(label: string, work: () => Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: the concurrent change did not commit within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Runs `request` paused at `probe`, commits `change` during the pause, then releases it.
async function pausedAcross<T>(probe: string, request: () => Promise<T>, change: () => Promise<unknown>): Promise<T> {
  clearConcurrencyProbes()
  const paused = barrier()
  const release = barrier()
  setConcurrencyProbe(probe, async () => {
    paused.open()
    await release.promise
  })
  const pending = request()
  await paused.promise
  await commitWithin(probe, change)
  release.open()
  try {
    return await pending
  } finally {
    clearConcurrencyProbes()
  }
}

function sameOutcome(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function summary(outcome: Awaited<ReturnType<typeof resolveRaw>>): string {
  if (!outcome.ok) return `${outcome.code}: ${outcome.message}`
  return JSON.stringify({ status: outcome.value.resolutionStatus, winner: outcome.value.governingSourceVersionId, matched: outcome.value.matchedApplicabilityIds.length, blockers: outcome.value.blockers })
}

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.8-snapshot] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  section('S1  A3.8 paused after context: the facility profile is replaced mid-request')
  {
    // The only applicability row requires profile P1. Before: P1 is in force, the row matches and
    // the (INACTIVE-sourced) rule is blocked by A3.7. After: P1 was closed and P2 took over, so the
    // row no longer matches and the answer is NO_MATCH. A request that read context before the
    // change and A3.7's own context after it would combine the two.
    const facility = await fx.facility('s1')
    const p1 = await fx.profile(facility.id, '2026-01-01', null, 'AE-DU')
    const rule = await fx.makeRule('s1')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id, { facilityRegulatoryProfileId: p1.id })
    await fx.attachSource(version.id, 's1-src', { activationStatus: 'INACTIVE' })
    const context = { facilityId: facility.id }

    const before = await resolveRaw(rule.id, businessDate, context)
    const mid = await pausedAcross('rule_resolution.after_context', () => resolveRaw(rule.id, businessDate, context), () =>
      prisma.$transaction([
        prisma.facilityRegulatoryProfile.update({ where: { id: p1.id }, data: { effectiveTo: d('2026-02-28') } }),
        prisma.facilityRegulatoryProfile.create({
          data: { facilityId: facility.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: d('2026-03-01'), status: 'ACTIVE' },
        }),
      ]),
    )
    const after = await resolveRaw(rule.id, businessDate, context)

    console.log(`  before: ${summary(before)}\n  mid:    ${summary(mid)}\n  after:  ${summary(after)}`)
    check('the change was real: a fresh request after it gives a different answer', !sameOutcome(before, after))
    check('the paused request answers exactly as the state it started in (byte-identical)', sameOutcome(mid, before), summary(mid))
    check('it is not a mixture: it equals one of the two consistent states', sameOutcome(mid, before) || sameOutcome(mid, after))
  }

  section('S2  A3.8 paused after the A3.7 gate: the only candidate gains a CONFLICTS_WITH edge')
  {
    // Before: B is a valid candidate -> RESOLVED B. After: B conflicts -> no candidate ->
    // BLOCKED_EXECUTABILITY with A3.7's reasons. Mixing a before-state gate with an after-state
    // candidate check would yield a BLOCKED result carrying no reason at all.
    const rule = await fx.makeRule('s2')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const b = await fx.attachSource(version.id, 's2-B')
    const unrelated = await fx.attachSource((await fx.makeRuleVersion((await fx.makeRule('s2-other')).id, '1')).id, 's2-C')

    const before = await resolveRaw(rule.id, businessDate)
    const mid = await pausedAcross('rule_resolution.after_gate', () => resolveRaw(rule.id, businessDate), () =>
      fx.relate(b.sourceVersion.id, unrelated.sourceVersion.id, 'CONFLICTS_WITH'),
    )
    const after = await resolveRaw(rule.id, businessDate)

    console.log(`  before: ${summary(before)}\n  mid:    ${summary(mid)}\n  after:  ${summary(after)}`)
    check('the change was real: a fresh request after it gives a different answer', !sameOutcome(before, after))
    check('the paused request answers exactly as the state it started in (byte-identical)', sameOutcome(mid, before), summary(mid))
    check(
      'no BLOCKED result without a reason',
      !(mid.ok && mid.value.resolutionStatus.startsWith('BLOCKED') && mid.value.blockers.length === 0),
      summary(mid),
    )
  }

  section('S3  A3.8 paused before the graph: a SUPERSEDES edge appears between two candidates')
  {
    // Before: A and B are unrelated -> tie. After: B SUPERSEDES A -> RESOLVED B. The candidate set
    // is identical in both states, so without a snapshot the late graph read silently switches
    // the answer for a request whose earlier stages read the before-state.
    const rule = await fx.makeRule('s3')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const a = await fx.attachSource(version.id, 's3-A')
    const b = await fx.attachSource(version.id, 's3-B')

    const before = await resolveRaw(rule.id, businessDate)
    const mid = await pausedAcross('rule_resolution.before_graph', () => resolveRaw(rule.id, businessDate), () =>
      fx.relate(b.sourceVersion.id, a.sourceVersion.id, 'SUPERSEDES'),
    )
    const after = await resolveRaw(rule.id, businessDate)

    console.log(`  before: ${summary(before)}\n  mid:    ${summary(mid)}\n  after:  ${summary(after)}`)
    check('the change was real: a fresh request after it gives a different answer', !sameOutcome(before, after))
    check('the paused request answers exactly as the state it started in (byte-identical)', sameOutcome(mid, before), summary(mid))
  }

  section('S4  A3.7 on its own, paused after context: the only candidate gains a CONFLICTS_WITH edge')
  {
    const rule = await fx.makeRule('s4')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const b = await fx.attachSource(version.id, 's4-B')
    const unrelated = await fx.attachSource((await fx.makeRuleVersion((await fx.makeRule('s4-other')).id, '1')).id, 's4-C')
    const gate = () => evaluateExecutability(version.id, businessDate, emptyContext())

    const before = await gate()
    const mid = await pausedAcross('rule_executability.after_context', gate, () =>
      fx.relate(b.sourceVersion.id, unrelated.sourceVersion.id, 'CONFLICTS_WITH'),
    )
    const after = await gate()

    const show = (o: typeof before) => (o.ok ? JSON.stringify({ gate: o.value.gateStatus, blockers: o.value.blockers }) : o.code)
    console.log(`  before: ${show(before)}\n  mid:    ${show(mid)}\n  after:  ${show(after)}`)
    check('the change was real: a fresh gate evaluation after it differs', !sameOutcome(before, after))
    check('the paused gate evaluation answers exactly as the state it started in', sameOutcome(mid, before), show(mid))
  }

  section('The snapshot is read-only and leaves no trace')
  {
    const auditBefore = await prisma.auditEvent.count()
    const rule = await fx.makeRule('trace')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    await fx.attachSource(version.id, 'trace-src')
    const auditAfterFixtures = await prisma.auditEvent.count()
    await resolveRaw(rule.id, businessDate)
    check('no AuditEvent is written by an evaluation', (await prisma.auditEvent.count()) === auditAfterFixtures && auditAfterFixtures === auditBefore)
    const open = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'`
    check('no transaction is left open after the evaluations', Number(open[0].n) === 0, String(open[0].n))
  }

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.8-snapshot] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
