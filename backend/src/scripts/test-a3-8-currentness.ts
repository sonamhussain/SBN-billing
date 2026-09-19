import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import type { RuleResolutionDto } from '../modules/rule-resolution/rule-resolution.types.ts'
import { a38Fixtures, createChecker, d, resolve } from './support/a3-8-fixtures.ts'

// Audit F02 — historicalOnly from ONE captured server evaluation instant. businessDate selects the
// rule and source; evaluationDate (the UTC calendar date of that instant) only says whether the
// selected versions are current now. Every check freezes the clock, and every case is evaluated
// under two different clocks to prove the clock changes this metadata and nothing else.

const { check, eq, section, finish } = createChecker('a3.8-currentness')

const tag = `A38N-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID

// A clock frozen at one instant that also counts how often it is read.
function frozenClock(iso: string) {
  let reads = 0
  const instant = new Date(iso)
  return {
    clock: () => {
      reads += 1
      return new Date(instant.getTime())
    },
    reads: () => reads,
  }
}

const TODAY = '2026-09-18T10:00:00.000Z'

// Every field of the response except historicalOnly.
function selection(dto: RuleResolutionDto): string {
  const { historicalOnly: _ignored, ...rest } = dto
  return JSON.stringify(rest)
}

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.8-currentness] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  async function resolvedRule(
    name: string,
    rule: { from: string; to?: string | null; effectType?: string },
    source?: { from: string; to?: string | null; status?: string },
  ) {
    const definition = await fx.makeRule(name)
    const version = await fx.makeRuleVersion(definition.id, '1', {
      effectType: rule.effectType,
      effectiveFrom: d(rule.from),
      effectiveTo: rule.to ? d(rule.to) : null,
    })
    await fx.makeApplicability(version.id)
    const attached = source
      ? await fx.attachSource(version.id, `${name}-src`, {
          effectiveFrom: d(source.from),
          effectiveTo: source.to ? d(source.to) : null,
          activationStatus: source.status,
        })
      : null
    return { definition, version, attached }
  }

  // Resolves under two clocks and asserts the selection is identical.
  async function underTwoClocks(label: string, ruleId: string, businessDate: string, clockA: string, clockB: string) {
    const a = await resolve(ruleId, businessDate, {}, { clock: frozenClock(clockA).clock })
    const b = await resolve(ruleId, businessDate, {}, { clock: frozenClock(clockB).clock })
    check(`${label}: changing the evaluation clock changes nothing but historicalOnly`, selection(a) === selection(b), `${selection(a)}\n    vs ${selection(b)}`)
    return { a, b }
  }

  section('REF-02 Table 5, end to end, with the clock frozen at 2026-09-18')

  {
    const r = await resolvedRule('current', { from: '2026-01-01' }, { from: '2026-01-01' })
    const dto = await resolve(r.definition.id, '2026-03-15', {}, { clock: frozenClock(TODAY).clock })
    check('rule current, source ACTIVE and effective -> false', dto.resolutionStatus === 'RESOLVED' && dto.historicalOnly === false, JSON.stringify(dto))
    check('a past businessDate while the same rule and source are still current -> false', dto.historicalOnly === false)
  }

  {
    const r = await resolvedRule('rule-expired', { from: '2025-01-01', to: '2025-12-31' }, { from: '2025-01-01' })
    const dto = await resolve(r.definition.id, '2025-06-15', {}, { clock: frozenClock(TODAY).clock })
    check('rule expired, source ACTIVE and effective -> true', dto.resolutionStatus === 'RESOLVED' && dto.historicalOnly === true, JSON.stringify(dto))
  }

  const sourceExpired = await resolvedRule('source-expired', { from: '2026-01-01' }, { from: '2026-01-01', to: '2026-06-30' })
  {
    const dto = await resolve(sourceExpired.definition.id, '2026-03-15', {}, { clock: frozenClock(TODAY).clock })
    check(
      'rule current, source still ACTIVE but its period ended -> true (stored ACTIVE alone is not currentness)',
      dto.resolutionStatus === 'RESOLVED' && dto.historicalOnly === true,
      JSON.stringify({ status: dto.resolutionStatus, historicalOnly: dto.historicalOnly }),
    )
  }

  {
    const definition = await fx.makeRule('superseded')
    const version = await fx.makeRuleVersion(definition.id, '1', { effectiveFrom: d('2026-01-01') })
    await fx.makeApplicability(version.id)
    const old = await fx.attachSource(version.id, 'sup-old', { effectiveFrom: d('2026-01-01'), activationStatus: 'SUPERSEDED' })
    const successor = await fx.attachSource(version.id, 'sup-new', { effectiveFrom: d('2026-06-01') })
    await fx.relate(successor.sourceVersion.id, old.sourceVersion.id, 'SUPERSEDES')
    const dto = await resolve(definition.id, '2026-03-15', {}, { clock: frozenClock(TODAY).clock })
    check(
      'rule current, winning source SUPERSEDED -> true',
      dto.governingSourceVersionId === old.sourceVersion.id && dto.historicalOnly === true,
      JSON.stringify({ winner: dto.governingSourceVersionId, historicalOnly: dto.historicalOnly }),
    )
  }

  const referenceExpired = await resolvedRule('reference-expired', { from: '2025-01-01', to: '2025-12-31', effectType: 'REFERENCE_ONLY' })
  {
    const dto = await resolve(referenceExpired.definition.id, '2025-06-15', {}, { clock: frozenClock(TODAY).clock })
    check(
      'REFERENCE_ONLY rule no longer in force -> true, with no governing source invented',
      dto.resolutionStatus === 'REFERENCE_ONLY' && dto.historicalOnly === true && dto.governingSourceVersionId === null,
      JSON.stringify({ status: dto.resolutionStatus, historicalOnly: dto.historicalOnly }),
    )
    const current = await resolvedRule('reference-current', { from: '2026-01-01', effectType: 'REFERENCE_ONLY' })
    const currentDto = await resolve(current.definition.id, '2026-03-15', {}, { clock: frozenClock(TODAY).clock })
    check('REFERENCE_ONLY rule still in force -> false', currentDto.resolutionStatus === 'REFERENCE_ONLY' && currentDto.historicalOnly === false)
  }

  const endsToday = await resolvedRule('ends-today', { from: '2026-01-01', to: '2026-09-18' }, { from: '2026-01-01', to: '2026-09-18' })
  {
    const lastSecond = await resolve(endsToday.definition.id, '2026-03-15', {}, { clock: frozenClock('2026-09-18T23:59:59.999Z').clock })
    check('a period ending ON evaluationDate is still current for that whole inclusive day -> false', lastSecond.historicalOnly === false)
    const nextDay = await resolve(endsToday.definition.id, '2026-03-15', {}, { clock: frozenClock('2026-09-19T00:00:00.000Z').clock })
    check('from the next UTC day it is historical -> true', nextDay.historicalOnly === true)
  }

  const future = await resolvedRule('future', { from: '2027-01-01' }, { from: '2027-01-01' })
  {
    const dto = await resolve(future.definition.id, '2027-03-15', {}, { clock: frozenClock(TODAY).clock })
    check(
      'a future-effective selection not yet current -> RESOLVED for its businessDate, but true (a non-current reference, not authority now)',
      dto.resolutionStatus === 'RESOLVED' && dto.historicalOnly === true,
      JSON.stringify({ status: dto.resolutionStatus, historicalOnly: dto.historicalOnly }),
    )
  }

  section('The clock changes only historicalOnly, never the businessDate-driven selection')
  {
    const { a, b } = await underTwoClocks('source period ended', sourceExpired.definition.id, '2026-03-15', '2026-04-01T00:00:00Z', TODAY)
    check('evaluated in April the source is still current -> false; in September -> true', a.historicalOnly === false && b.historicalOnly === true, JSON.stringify([a.historicalOnly, b.historicalOnly]))
  }
  {
    const { a, b } = await underTwoClocks('reference rule expired', referenceExpired.definition.id, '2025-06-15', '2025-07-01T00:00:00Z', TODAY)
    check('evaluated in 2025 the reference is current -> false; in 2026 -> true', a.historicalOnly === false && b.historicalOnly === true)
  }
  {
    const { a, b } = await underTwoClocks('future selection', future.definition.id, '2027-03-15', TODAY, '2027-02-01T00:00:00Z')
    check('evaluated before 2027 -> true; evaluated once in force -> false', a.historicalOnly === true && b.historicalOnly === false)
  }

  section('One instant, captured once, in UTC')
  {
    const counter = frozenClock(TODAY)
    await resolve(sourceExpired.definition.id, '2026-03-15', {}, { clock: counter.clock })
    eq('the clock is read exactly once for a full RESOLVED evaluation', counter.reads(), 1)
    const refCounter = frozenClock(TODAY)
    await resolve(referenceExpired.definition.id, '2025-06-15', {}, { clock: refCounter.clock })
    eq('and exactly once for a REFERENCE_ONLY evaluation', refCounter.reads(), 1)

    // 23:30 on the 18th at -05:00 is 04:30 UTC on the 19th; 22:00 UTC on the 18th is already the
    // 19th in the UAE (+04:00). The convention is UTC, never the host's or the UAE's local date.
    const lateLocal = await resolve(endsToday.definition.id, '2026-03-15', {}, { clock: frozenClock('2026-09-18T23:30:00-05:00').clock })
    check('an instant whose UTC date is the 19th is judged on the 19th -> true', lateLocal.historicalOnly === true)
    const lateUtc = await resolve(endsToday.definition.id, '2026-03-15', {}, { clock: frozenClock('2026-09-18T22:00:00Z').clock })
    check('an instant whose UTC date is the 18th is judged on the 18th, even though it is the 19th in the UAE -> false', lateUtc.historicalOnly === false)
  }

  section('Non-authoritative outcomes keep the default flag')
  {
    const nomatch = await fx.makeRule('no-match')
    const dto = await resolve(nomatch.id, '2026-03-15', {}, { clock: frozenClock(TODAY).clock })
    check('NO_MATCH carries historicalOnly false and no winner — it is not an answer at all', dto.resolutionStatus === 'NO_MATCH' && dto.historicalOnly === false && dto.governingSourceVersionId === null)
  }

  section('Resolution is read-only')
  {
    const auditBefore = await prisma.auditEvent.count()
    await resolve(sourceExpired.definition.id, '2026-03-15', {}, { clock: frozenClock(TODAY).clock })
    check('no AuditEvent is written', (await prisma.auditEvent.count()) === auditBefore)
  }

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.8-currentness] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
