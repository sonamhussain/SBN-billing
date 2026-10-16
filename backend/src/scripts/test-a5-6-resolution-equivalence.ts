import 'dotenv/config'
import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../shared/database/prisma.ts'
import type { DbClient } from '../shared/database/database.types.ts'
import { formatDateOnly } from '../shared/rules/date-only.ts'
import { evaluateRuleResolutionBundle } from '../modules/rule-resolution/rule-resolution.service.ts'
import { resolvePreClaimCommercialContext } from '../modules/pre-claim-commercial-context/pre-claim-commercial-context.service.ts'
import { evaluateEvidenceCompleteness } from '../modules/evidence-requirement/evidence-requirement.service.ts'
import {
  findDocumentationRuleDefinitionIds,
  findPossiblyApplicableRuleDefinitionIds,
  findResolvedRuleVersion,
  type CandidateContext,
} from '../modules/evidence-requirement/evidence-requirement.repository.ts'
import { a38Fixtures, d } from './support/a3-8-fixtures.ts'

// Performance corrective — the candidate filter must never change an A5.6 answer.
//
// Part 1 (definition level, the soundness property): for many contexts, every documentation
// RuleDefinition is run through the unchanged A3.8 resolver, exactly as A5.6 did before the corrective.
// Every definition the filter leaves out must be one A3.8 answers NO_MATCH for (or, for the first
// definition's context-wide refusal, the same refusal). The contexts come from the existing synthetic
// catalogue itself — each documentation version's own applicability rows on its own effective date — so
// RESOLVED, conflicting (specificity tie, source precedence), REFERENCE_ONLY, wildcard and
// date-bounded rules are all exercised, plus encounter contexts and partial contexts.
//
// Part 2 (service level): for real encounters (encounter, activity and diagnosis targets) the new A5.6
// evaluation is compared with the pre-corrective loop, replayed here from the full A3.8 scan on the
// SAME snapshot: the same failure reason and message, or the same resolved rule versions and evidence
// requirements in the same order.
//
// Part 3 (synthetic matrix, exactness): the catalogue has no wildcard, facility-, profile- or
// date-bounded documentation rows and no REFERENCE_ONLY or source-conflict documentation rule, so a
// separate synthetic organization is given one definition per case (built through the A3.8 fixture
// helpers) and judged in several contexts: the filter must keep exactly the definitions A3.8 does not
// answer NO_MATCH for — the only allowed difference is a profile-scoped row, which the filter
// deliberately never narrows on.
//
// Part 4 (refusals): the pre-corrective and corrective loops give the same refusal, block or resolution
// for missing, foreign, malformed and conflicting context, a facility without a regulatory profile,
// with and without any candidate, and for an organization with no documentation rule.
//
// Parts 1 and 2 are read-only (REPEATABLE READ transactions that are rolled back); Part 3 adds its own
// synthetic organizations and rules, nothing else.
//
//   node --env-file=.env src/scripts/test-a5-6-resolution-equivalence.ts [rowContexts] [encounters]

const DOCUMENTATION_EFFECT = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const organizationId = process.env.A1_IT_ORGANIZATION_ID as string
const rowContextLimit = Number(process.argv[2] ?? '60')
const encounterLimit = Number(process.argv[3] ?? '12')

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) passed += 1
  else failed += 1
  console.log(`[a5.6-equivalence] ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const DIMENSIONS: (keyof CandidateContext)[] = [
  'facilityId',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'providerContractId',
  'tariffScheduleId',
  'tariffScheduleVersionId',
  'serviceId',
  'procedureCodeId',
  'diagnosisCodeId',
]
const emptyContext = (): CandidateContext => Object.fromEntries(DIMENSIONS.map((key) => [key, null])) as CandidateContext

class Rollback extends Error {}
async function inSnapshot<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
  let value: T | undefined
  try {
    await prisma.$transaction(
      async (tx) => {
        value = await work(tx)
        throw new Rollback()
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 3_600_000 },
    )
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return value as T
}

type Outcome = { kind: 'error'; text: string } | { kind: 'status'; status: string; ruleVersionId: string | null }
const describe = (outcome: Outcome) => (outcome.kind === 'error' ? `error ${outcome.text}` : outcome.status)

// The unchanged A3.8 resolver for one definition, exactly as A5.6 calls it.
async function resolveOne(ruleDefinitionId: string, businessDate: string, context: CandidateContext, clock: Date, tx: DbClient): Promise<Outcome> {
  const bundle = await evaluateRuleResolutionBundle(ruleDefinitionId, businessDate, { ...context }, { db: tx, clock: () => clock })
  if (!bundle.ok) return { kind: 'error', text: `${bundle.code}: ${bundle.message}` }
  return { kind: 'status', status: bundle.value.resolution.resolutionStatus, ruleVersionId: bundle.value.resolution.ruleVersionId ?? null }
}

const histogram = new Map<string, number>()
const count = (key: string) => histogram.set(key, (histogram.get(key) ?? 0) + 1)

// Part 1 — every definition the filter drops is NO_MATCH (or the first definition's context-wide refusal).
async function soundness(label: string, businessDate: string, context: CandidateContext) {
  await inSnapshot(async (tx) => {
    const clock = (await tx.$queryRaw<{ now: Date }[]>`SELECT transaction_timestamp() AS now`)[0].now
    const definitionIds = await findDocumentationRuleDefinitionIds(organizationId, DOCUMENTATION_EFFECT, tx)
    const kept = (await findPossiblyApplicableRuleDefinitionIds(definitionIds, businessDate, context, tx)) ?? new Set(definitionIds)
    const outcomes: Outcome[] = []
    for (const id of definitionIds) outcomes.push(await resolveOne(id, businessDate, context, clock, tx))
    for (const outcome of outcomes) count(outcome.kind === 'error' ? 'context-wide refusal' : outcome.status)
    const firstRefusal = outcomes[0]?.kind === 'error' ? outcomes[0].text : null
    const violations = definitionIds.filter((id, index) => {
      if (index === 0 || kept.has(id)) return false
      const outcome = outcomes[index]
      if (outcome.kind === 'status') return outcome.status !== 'NO_MATCH'
      return outcome.text !== firstRefusal
    })
    const notNoMatch = outcomes.filter((o) => !(o.kind === 'status' && o.status === 'NO_MATCH')).length
    check(
      `soundness ${label}`,
      violations.length === 0,
      violations.length === 0
        ? `${definitionIds.length} definitions, ${kept.size} kept by the filter, ${notNoMatch} not NO_MATCH under A3.8 — every dropped definition is NO_MATCH`
        : `dropped but not NO_MATCH: ${violations.slice(0, 5).map((id) => `${id} ${describe(outcomes[definitionIds.indexOf(id)])}`).join('; ')}`,
    )
  })
}

// The pre-corrective A5.6 loop, replayed from the full A3.8 scan (the oracle for Part 2).
type Reference = { ok: false; reason: string; message: string } | { ok: true; ruleVersionIds: string[]; evidenceRequirementIds: string[] }
async function referenceLoop(businessDate: string, context: CandidateContext, storedProfileId: string | null, clock: Date, tx: DbClient): Promise<Reference> {
  const ruleVersionIds: string[] = []
  const evidenceRequirementIds: string[] = []
  for (const id of await findDocumentationRuleDefinitionIds(organizationId, DOCUMENTATION_EFFECT, tx)) {
    const bundle = await evaluateRuleResolutionBundle(id, businessDate, { ...context }, { db: tx, clock: () => clock })
    if (!bundle.ok) return { ok: false, reason: 'REQUIREMENT_RESOLUTION_BLOCKED', message: `a documentation rule could not be resolved for this encounter: ${bundle.message}` }
    const resolution = bundle.value.resolution
    if (resolution.resolutionStatus === 'NO_MATCH' || resolution.resolutionStatus === 'REFERENCE_ONLY') continue
    if (resolution.resolutionStatus !== 'RESOLVED' || !resolution.ruleVersionId)
      return { ok: false, reason: 'REQUIREMENT_RESOLUTION_BLOCKED', message: `an applicable documentation rule is ${resolution.resolutionStatus} in A3 governance` }
    if (bundle.value.authoritativeContext.facilityRegulatoryProfileId !== storedProfileId)
      return { ok: false, reason: 'REQUIREMENT_RESOLUTION_BLOCKED', message: "A3 resolved a different facility regulatory profile than the encounter's stored one" }
    const version = await findResolvedRuleVersion(resolution.ruleVersionId, tx)
    if (!version || version.effectType !== DOCUMENTATION_EFFECT || !version.evidenceRequirement || version.evidenceRequirement.documentTypes.length === 0)
      return { ok: false, reason: 'CONFIGURATION_INCOMPLETE', message: 'a resolved documentation rule version has no complete evidence requirement payload' }
    ruleVersionIds.push(version.id)
    evidenceRequirementIds.push(version.evidenceRequirement.id)
  }
  return { ok: true, ruleVersionIds, evidenceRequirementIds }
}

async function serviceEquivalence(label: string, encounterId: string, body: Record<string, string>) {
  await inSnapshot(async (tx) => {
    const actual = await evaluateEvidenceCompleteness(encounterId, body, tx)
    const commercial = await resolvePreClaimCommercialContext(encounterId, tx)
    if (!commercial.ok) {
      check(`service ${label}`, !actual.ok && actual.code === commercial.code, `both refuse before resolution (${commercial.code})`)
      return
    }
    const c = commercial.value
    const context: CandidateContext = { ...emptyContext(), facilityId: c.facilityId, payerId: c.payerId, tpaId: c.tpaId, networkId: c.networkId, insuranceProductId: c.insuranceProductId, providerContractId: c.providerContractId, tariffScheduleId: c.tariffScheduleId, tariffScheduleVersionId: c.tariffScheduleVersionId }
    if (body.encounterActivityId) {
      const activity = await tx.encounterActivity.findUniqueOrThrow({ where: { id: body.encounterActivityId } })
      context.serviceId = activity.serviceId
      context.procedureCodeId = activity.procedureCodeId
    }
    if (body.encounterDiagnosisId) context.diagnosisCodeId = (await tx.encounterDiagnosis.findUniqueOrThrow({ where: { id: body.encounterDiagnosisId } })).diagnosisCodeId
    const clock = (await tx.$queryRaw<{ now: Date }[]>`SELECT transaction_timestamp() AS now`)[0].now
    const reference = await referenceLoop(c.serviceDate, context, c.facilityRegulatoryProfileId, clock, tx)
    if (!reference.ok) {
      const same = !actual.ok && (actual as { reason?: string }).reason === reference.reason && actual.message === reference.message
      check(`service ${label}`, same, same ? `both fail closed: ${reference.reason}` : `reference ${reference.reason}: ${reference.message} / actual ${actual.ok ? 'ok' : `${(actual as { reason?: string }).reason}: ${actual.message}`}`)
      return
    }
    const actualVersions = actual.ok ? actual.value.requirements.map((r) => r.ruleVersionId) : []
    const actualRequirements = actual.ok ? actual.value.requirements.map((r) => r.evidenceRequirementId) : []
    const same = actual.ok && JSON.stringify(actualVersions) === JSON.stringify(reference.ruleVersionIds) && JSON.stringify(actualRequirements) === JSON.stringify(reference.evidenceRequirementIds)
    check(`service ${label}`, same, same ? `${reference.ruleVersionIds.length} requirement(s), identical rule versions and requirements in the same order` : `reference [${reference.ruleVersionIds.join(',')}] / actual ${actual.ok ? `[${actualVersions.join(',')}]` : actual.message}`)
  })
}

// Part 3 — one synthetic definition per case in a fresh organization, judged for exactness.
async function syntheticMatrix() {
  const tag = `A56EQ-${Date.now()}`
  const org = (await prisma.organization.create({ data: { name: `${tag} synthetic organization` } })).id
  const fx = a38Fixtures(org, tag)
  const F = await fx.facility('F')
  const profileF = await fx.profile(F.id, '2020-01-01', null)
  const G = await fx.facility('G')
  await fx.profile(G.id, '2020-01-01', null)
  const X = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} payer X` } })
  const Y = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} payer Y` } })
  const S = await prisma.service.create({ data: { organizationId: org, internalCode: `${tag}-S`, displayName: 'Synthetic service S' } })

  type VersionSpec = { from?: string | null; to?: string; effect?: string; status?: string; rows: Record<string, string>[]; sources?: 'one' | 'tie' | 'superseding' | 'none' }
  const names = new Map<string, string>()
  const definition = async (name: string, versions: VersionSpec[]) => {
    const rule = await fx.makeRule(name)
    names.set(rule.id, name)
    for (const [index, spec] of versions.entries()) {
      const version = await fx.makeRuleVersion(rule.id, String(index + 1), {
        effectType: spec.effect ?? DOCUMENTATION_EFFECT,
        effectiveFrom: spec.from === undefined ? d('2020-01-01') : spec.from === null ? null : d(spec.from),
        effectiveTo: spec.to ? d(spec.to) : null,
        verificationStatus: spec.status ?? 'VERIFIED',
      })
      for (const row of spec.rows) await fx.makeApplicability(version.id, row)
      const sources = spec.sources ?? 'one'
      if (sources === 'one') await fx.attachSource(version.id, `${name}-${index}`)
      if (sources === 'tie') {
        const first = await fx.attachSource(version.id, `${name}-${index}-a`)
        await fx.bind(version.id, (await fx.addInterpretation(first.sourceVersion.id, `${name}-${index}-b`)).id)
      }
      if (sources === 'superseding') {
        const old = await fx.attachSource(version.id, `${name}-${index}-old`, { effectiveFrom: d('2020-01-01') })
        const successor = await fx.attachSource(version.id, `${name}-${index}-new`, { effectiveFrom: d('2026-06-01') })
        await fx.relate(successor.sourceVersion.id, old.sourceVersion.id, 'SUPERSEDES')
      }
    }
  }
  await definition('wildcard', [{ rows: [{}] }])
  await definition('facility-F', [{ rows: [{ facilityId: F.id }] }])
  await definition('profile-of-F', [{ rows: [{ facilityRegulatoryProfileId: profileF.id }] }])
  await definition('payer-X', [{ rows: [{ payerId: X.id }] }])
  await definition('payer-X-or-Y', [{ rows: [{ payerId: X.id }, { payerId: Y.id }] }])
  await definition('payer-X-and-service-S', [{ rows: [{ payerId: X.id, serviceId: S.id }] }])
  await definition('expired-2025', [{ from: '2025-01-01', to: '2025-12-31', rows: [{}] }])
  await definition('future-2027', [{ from: '2027-01-01', rows: [{}] }])
  await definition('no-effective-from', [{ from: null, rows: [{}] }])
  // A version ending before it starts cannot exist: rule_versions_effective_date_chk refuses it.
  await definition('unverified', [{ status: 'UNVERIFIED', rows: [{}] }])
  await definition('specificity-tie', [{ rows: [{ payerId: X.id }] }, { rows: [{ payerId: X.id }] }])
  await definition('reference-only', [{ status: 'UNVERIFIED', rows: [{}] }, { effect: 'REFERENCE_ONLY', rows: [{}], sources: 'none' }])
  await definition('source-precedence-tie', [{ rows: [{}], sources: 'tie' }])
  await definition('no-governing-source', [{ rows: [{}], sources: 'none' }])
  await definition('source-supersession', [{ rows: [{}], sources: 'superseding' }])
  await definition('more-specific-wins', [{ rows: [{}] }, { rows: [{ payerId: X.id }] }])

  const contexts: { label: string; date: string; context: CandidateContext }[] = [
    { label: 'facility F + payer Y', date: '2026-06-15', context: { ...emptyContext(), facilityId: F.id, payerId: Y.id } },
    { label: 'facility G + payer X + service S', date: '2026-06-15', context: { ...emptyContext(), facilityId: G.id, payerId: X.id, serviceId: S.id } },
    { label: 'facility F + payer X (2025)', date: '2025-06-15', context: { ...emptyContext(), facilityId: F.id, payerId: X.id } },
    { label: 'empty context', date: '2026-06-15', context: emptyContext() },
    { label: 'facility F + payer X + service S (2027)', date: '2027-06-15', context: { ...emptyContext(), facilityId: F.id, payerId: X.id, serviceId: S.id } },
    { label: 'facility F + payer X (before supersession)', date: '2026-03-15', context: { ...emptyContext(), facilityId: F.id, payerId: X.id } },
  ]
  for (const { label, date, context } of contexts) {
    await inSnapshot(async (tx) => {
      const clock = (await tx.$queryRaw<{ now: Date }[]>`SELECT transaction_timestamp() AS now`)[0].now
      const definitionIds = await findDocumentationRuleDefinitionIds(org, DOCUMENTATION_EFFECT, tx)
      const kept = (await findPossiblyApplicableRuleDefinitionIds(definitionIds, date, context, tx)) ?? new Set(definitionIds)
      const statuses = new Map<string, Outcome>()
      for (const id of definitionIds) {
        const bundle = await evaluateRuleResolutionBundle(id, date, { ...context }, { db: tx, clock: () => clock })
        const outcome: Outcome = bundle.ok ? { kind: 'status', status: bundle.value.resolution.resolutionStatus, ruleVersionId: bundle.value.resolution.ruleVersionId ?? null } : { kind: 'error', text: `${bundle.code}: ${bundle.message}` }
        statuses.set(id, outcome)
        count(`synthetic ${outcome.kind === 'error' ? 'refusal' : outcome.status}`)
      }
      const dropped = definitionIds.filter((id) => !kept.has(id))
      const unsound = dropped.filter((id) => {
        const outcome = statuses.get(id) as Outcome
        return !(outcome.kind === 'status' && outcome.status === 'NO_MATCH')
      })
      const widened = definitionIds.filter((id) => {
        const outcome = statuses.get(id) as Outcome
        return kept.has(id) && outcome.kind === 'status' && outcome.status === 'NO_MATCH'
      })
      const widenedOk = widened.every((id) => names.get(id) === 'profile-of-F')
      const summary = definitionIds.map((id) => `${names.get(id)}=${kept.has(id) ? 'kept' : 'dropped'}/${describe(statuses.get(id) as Outcome)}`).join(', ')
      check(
        `synthetic exactness ${label} @ ${date}`,
        unsound.length === 0 && widenedOk && definitionIds.length === names.size,
        unsound.length > 0
          ? `dropped but not NO_MATCH: ${unsound.map((id) => names.get(id)).join(', ')}`
          : !widenedOk
            ? `kept but NO_MATCH beyond the profile row: ${widened.map((id) => names.get(id)).join(', ')}`
            : summary,
      )
    })
  }
}

// Part 4 — refusals. The A5.6 loop is run twice over the same definitions and snapshot: once over every
// definition (pre-corrective) and once exactly as the corrective does (the candidate set plus the first
// definition, or every definition when the candidate set is "do not narrow"). Both must give the same
// refusal, the same blocking status or the same resolved versions — for missing, foreign, malformed and
// conflicting context, a facility without a regulatory profile, with and without any candidate, and for
// an organization with no documentation rule at all.
type LoopOutcome = { kind: 'refusal'; text: string } | { kind: 'blocked'; status: string } | { kind: 'resolved'; ruleVersionIds: string[] }
async function loopOutcome(definitionIds: string[], evaluate: (id: string) => boolean, date: string, context: Record<string, string | null>, clock: Date, tx: DbClient) {
  let evaluated = 0
  const ruleVersionIds: string[] = []
  for (const [index, id] of definitionIds.entries()) {
    if (!evaluate(id) && index > 0) continue
    evaluated += 1
    const bundle = await evaluateRuleResolutionBundle(id, date, { ...context }, { db: tx, clock: () => clock })
    if (!bundle.ok) return { outcome: { kind: 'refusal', text: `${bundle.code}: ${bundle.message}` } as LoopOutcome, evaluated }
    const status = bundle.value.resolution.resolutionStatus
    if (status === 'NO_MATCH' || status === 'REFERENCE_ONLY') continue
    if (status !== 'RESOLVED' || !bundle.value.resolution.ruleVersionId) return { outcome: { kind: 'blocked', status } as LoopOutcome, evaluated }
    ruleVersionIds.push(bundle.value.resolution.ruleVersionId)
  }
  return { outcome: { kind: 'resolved', ruleVersionIds } as LoopOutcome, evaluated }
}

async function refusalEquivalence() {
  const tag = `A56RF-${Date.now()}`
  const org = (await prisma.organization.create({ data: { name: `${tag} synthetic organization` } })).id
  const fx = a38Fixtures(org, tag)
  const F = await fx.facility('F')
  await fx.profile(F.id, '2020-01-01', null)
  const withoutProfile = await fx.facility('no-profile')
  const X = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} payer X` } })
  const contract = await prisma.providerContract.create({ data: { organizationId: org, payerId: X.id, contractKey: `${tag}-C`, displayName: 'Synthetic contract', effectiveFrom: d('2020-01-01') } })
  const schedule1 = await prisma.tariffSchedule.create({ data: { providerContractId: contract.id, tariffKey: `${tag}-S1`, displayName: 'Synthetic schedule 1' } })
  const schedule2 = await prisma.tariffSchedule.create({ data: { providerContractId: contract.id, tariffKey: `${tag}-S2`, displayName: 'Synthetic schedule 2' } })
  const versionOf1 = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: schedule1.id, version: `${tag}-V1`, effectiveFrom: d('2020-01-01') } })
  const foreignPayer = await prisma.payer.findFirstOrThrow({ where: { organizationId: organizationId }, select: { id: true } })
  // Documentation definitions of every outcome kind: resolved (wildcard and payer-specific), a
  // specificity tie (conflicting rule versions) and an expired one.
  const define = async (name: string, rowsPerVersion: Record<string, string>[][], opts: { from?: string; to?: string } = {}) => {
    const rule = await fx.makeRule(name)
    for (const [index, rows] of rowsPerVersion.entries()) {
      const version = await fx.makeRuleVersion(rule.id, String(index + 1), { effectType: DOCUMENTATION_EFFECT, effectiveFrom: d(opts.from ?? '2020-01-01'), effectiveTo: opts.to ? d(opts.to) : null })
      for (const row of rows) await fx.makeApplicability(version.id, row)
      await fx.attachSource(version.id, `${name}-${index}`)
    }
  }
  await define('wildcard', [[{}]])
  await define('payer-X', [[{ payerId: X.id }]])
  await define('conflicting-tie', [[{ payerId: X.id }], [{ payerId: X.id }]])
  await define('expired', [[{}]], { from: '2020-01-01', to: '2021-12-31' })
  const emptyOrg = (await prisma.organization.create({ data: { name: `${tag} organization without documentation rules` } })).id

  const missing = '22222222-2222-4222-8222-222222222222'
  const cases: { label: string; org: string; context: Record<string, string | null>; expect: 'refusal' | 'any' }[] = [
    { label: 'missing facility', org, context: { facilityId: missing }, expect: 'refusal' },
    { label: 'foreign payer', org, context: { payerId: foreignPayer.id }, expect: 'refusal' },
    { label: 'malformed payer id', org, context: { payerId: 'not-a-uuid' }, expect: 'refusal' },
    { label: 'conflicting schedule and version', org, context: { tariffScheduleId: schedule2.id, tariffScheduleVersionId: versionOf1.id }, expect: 'refusal' },
    { label: 'facility without a regulatory profile', org, context: { facilityId: withoutProfile.id }, expect: 'refusal' },
    { label: 'valid facility and payer (resolves and conflicts)', org, context: { facilityId: F.id, payerId: X.id }, expect: 'any' },
    { label: 'valid empty context', org, context: {}, expect: 'any' },
    { label: 'organization without documentation rules', org: emptyOrg, context: { payerId: X.id }, expect: 'any' },
  ]
  for (const date of ['2026-06-15', '2019-06-15']) {
    for (const testCase of cases) {
      await inSnapshot(async (tx) => {
        const clock = (await tx.$queryRaw<{ now: Date }[]>`SELECT transaction_timestamp() AS now`)[0].now
        const definitionIds = await findDocumentationRuleDefinitionIds(testCase.org, DOCUMENTATION_EFFECT, tx)
        const candidateContext = { ...emptyContext(), ...testCase.context } as CandidateContext
        const candidates = await findPossiblyApplicableRuleDefinitionIds(definitionIds, date, candidateContext, tx)
        const before = await loopOutcome(definitionIds, () => true, date, testCase.context, clock, tx)
        const after = await loopOutcome(definitionIds, (id) => candidates === null || candidates.has(id), date, testCase.context, clock, tx)
        const same = JSON.stringify(before.outcome) === JSON.stringify(after.outcome)
        const expected = testCase.expect === 'any' || before.outcome.kind === 'refusal'
        const shown = before.outcome.kind === 'refusal' ? `refusal ${before.outcome.text.slice(0, 90)}` : before.outcome.kind === 'blocked' ? `blocked ${before.outcome.status}` : `resolved ${before.outcome.ruleVersionIds.length}`
        check(
          `refusal equivalence ${testCase.label} @ ${date}`,
          same && expected,
          `${shown}; ${definitionIds.length} definition(s): ${before.evaluated} evaluated before, ${after.evaluated} after${candidates === null ? ' (not narrowed)' : `, ${candidates.size} candidate(s)`}${same ? '' : ` — DIFFERENT: ${JSON.stringify(after.outcome).slice(0, 160)}`}`,
        )
      })
    }
  }
}

async function main() {
  console.log(`[a5.6-equivalence] organization ${organizationId}; ${rowContextLimit} catalogue contexts, ${encounterLimit} encounters`)

  // Part 1a — contexts taken from the documentation versions' own applicability rows, each on its
  // version's first effective day, so every kind of rule in the catalogue is reached.
  // One context per documentation definition (its first verified row), spread evenly across the whole
  // catalogue by a stable hash, so the sample is not dominated by one kind of rule.
  const rowContexts = await prisma.$queryRaw<(Record<string, string | null> & { business_date: Date })[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (d.id)
        d.id AS definition_id,
        a.facility_id::text, a.payer_id::text, a.tpa_id::text, a.network_id::text, a.insurance_product_id::text, a.provider_contract_id::text,
        a.tariff_schedule_id::text, a.tariff_schedule_version_id::text, a.service_id::text, a.procedure_code_id::text, a.diagnosis_code_id::text,
        v.effective_from AS business_date
      FROM rule_applicabilities a
      JOIN rule_versions v ON v.id = a.rule_version_id
      JOIN rule_definitions d ON d.id = v.rule_id
      WHERE d.organization_id = ${organizationId}::uuid AND v.verification_status = 'VERIFIED' AND v.effective_from IS NOT NULL
        AND EXISTS (SELECT 1 FROM rule_versions dv WHERE dv.rule_id = d.id AND dv.effect_type = ${DOCUMENTATION_EFFECT})
      ORDER BY d.id, v.created_at, a.id
    ) per_definition
    ORDER BY md5(definition_id::text)
    LIMIT ${rowContextLimit}`
  const column: Record<keyof CandidateContext, string> = {
    facilityId: 'facility_id', payerId: 'payer_id', tpaId: 'tpa_id', networkId: 'network_id', insuranceProductId: 'insurance_product_id', providerContractId: 'provider_contract_id',
    tariffScheduleId: 'tariff_schedule_id', tariffScheduleVersionId: 'tariff_schedule_version_id', serviceId: 'service_id', procedureCodeId: 'procedure_code_id', diagnosisCodeId: 'diagnosis_code_id',
  }
  for (const [index, row] of rowContexts.entries()) {
    const context = emptyContext()
    for (const key of DIMENSIONS) context[key] = row[column[key]] ?? null
    const businessDate = formatDateOnly(row.business_date) as string
    await soundness(`catalogue context ${index + 1} (${DIMENSIONS.filter((k) => context[k]).join('+') || 'wildcard'} @ ${businessDate})`, businessDate, context)
  }
  // Part 1b — partial and empty contexts: only wildcard rules can apply.
  await soundness('empty context @ 2026-06-15', '2026-06-15', emptyContext())
  await soundness('empty context @ 2020-01-01', '2020-01-01', emptyContext())

  // Part 2 — real encounters with a full commercial lineage, at encounter, activity and diagnosis level.
  const encounters = await prisma.$queryRaw<{ encounter_id: string }[]>`
    SELECT encounter_id::text FROM (
      SELECT DISTINCT ON (vr.encounter_id) vr.encounter_id, vr.created_at
      FROM validation_runs vr JOIN encounters e ON e.id = vr.encounter_id JOIN patients p ON p.id = e.patient_id
      WHERE p.organization_id = ${organizationId}::uuid AND vr.tariff_schedule_version_id IS NOT NULL
      ORDER BY vr.encounter_id, vr.created_at DESC
    ) latest ORDER BY created_at DESC LIMIT ${encounterLimit}`
  for (const { encounter_id: encounterId } of encounters) {
    await serviceEquivalence(`encounter ${encounterId}`, encounterId, {})
    const activity = await prisma.encounterActivity.findFirst({ where: { encounterId, removedAt: null }, orderBy: { id: 'asc' }, select: { id: true } })
    if (activity) await serviceEquivalence(`encounter ${encounterId} activity`, encounterId, { encounterActivityId: activity.id })
    const diagnosis = await prisma.encounterDiagnosis.findFirst({ where: { encounterId, removedAt: null }, orderBy: { id: 'asc' }, select: { id: true } })
    if (diagnosis) await serviceEquivalence(`encounter ${encounterId} diagnosis`, encounterId, { encounterDiagnosisId: diagnosis.id })
  }

  await syntheticMatrix()
  await refusalEquivalence()

  console.log(`[a5.6-equivalence] A3.8 outcomes exercised across all contexts: ${[...histogram.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`[a5.6-equivalence] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a5.6-equivalence] ALL CHECKS PASS' : '[a5.6-equivalence] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
  await prisma.$disconnect()
}

main().catch(async (error) => {
  console.error('[a5.6-equivalence] uncaught error (this itself is a FAIL):', error)
  process.exitCode = 1
  await prisma.$disconnect()
})
