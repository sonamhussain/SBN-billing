import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '../../../generated/prisma/client.ts'
import { evaluateLine, evaluateRun, lineFingerprint, runFingerprint, type RateCandidate, type SourceFacts } from '../claim-pricing/claim-pricing.calculator.ts'
import { assemblyFingerprint, canonicalJson, evaluateDraft, reduceOutcome, sourceMatchesPricing, type DraftSnapshot, type SnapshotPricing, type SnapshotSource } from './claim-draft.assembly.ts'
import { findingCatalogue, findingCodes, type FindingCode } from './claim-draft.types.ts'
import { validateCreateAssessmentBody, validatePreviewQuery } from './claim-draft.validation.ts'

// A6.4 — pure draft rules. Synthetic identifiers only; the pricing run below is produced by the A6.3
// calculator itself, so the drift comparison is checked against the real owner fingerprints.

const D = (value: string) => new Prisma.Decimal(value)
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CLAIM = id(1)
const ENCOUNTER = id(2)
const VERSION = id(3)
const CONTRACT = id(4)
const SCHEDULE = id(5)
const PROC = id(6)
const LINE1 = id(11)
const LINE2 = id(12)
const ACT1 = id(21)
const ACT2 = id(22)
const DX1 = id(31)
const DX2 = id(32)
const EDX1 = id(41)
const EDX2 = id(42)
const RATE = id(51)

const source = (activityId: string, overrides: Partial<SnapshotSource> = {}): SnapshotSource => ({
  encounterActivityId: activityId,
  encounterId: ENCOUNTER,
  serviceId: null,
  procedureCodeId: PROC,
  quantity: D('1.5'),
  unitCode: null,
  modifierCodes: [],
  removed: false,
  ...overrides,
})

const rates: RateCandidate[] = [
  { id: RATE, selectorKind: 'PROCEDURE_CODE', serviceId: null, procedureCodeId: PROC, unitCodeKey: null, modifierSignature: [], currencyCode: 'AED', unitTariffAmount: D('125.25') },
]

// A pricing run exactly as A6.3 would record it for the given lines.
function priceWithOwner(lines: { id: string; sequence: number; source: SnapshotSource }[]): SnapshotPricing {
  const facts: SourceFacts[] = lines.map((line) => ({ claimLineId: line.id, sequence: line.sequence, ...line.source }))
  const evaluations = facts.map((fact) => evaluateLine(fact, rates))
  const result = evaluateRun(evaluations)
  const fingerprints = evaluations.map((evaluation, index) => lineFingerprint(facts[index], evaluation, VERSION))
  return {
    id: id(90),
    claimId: CLAIM,
    pricingContractVersion: 'A6-PRICE-1',
    providerContractId: CONTRACT,
    tariffScheduleId: SCHEDULE,
    tariffScheduleVersionId: VERSION,
    overallResult: result.overallResult,
    lineCount: result.lineCount,
    pricedCount: result.pricedCount,
    currencyCode: result.currencyCode,
    totalExtendedAmount: result.total,
    inputStructureFingerprint: runFingerprint(CLAIM, VERSION, fingerprints),
    lines: evaluations.map((evaluation, index) => ({
      id: id(100 + index),
      claimLineId: evaluation.claimLineId,
      encounterActivityId: evaluation.encounterActivityId,
      lineSequenceAtEvaluation: evaluation.sequence,
      outcome: evaluation.outcome,
      tariffRateId: evaluation.tariffRateId,
      unitTariffAmount: evaluation.unitTariffAmount,
      quantityAtEvaluation: evaluation.quantity,
      extendedAmount: evaluation.extendedAmount,
      currencyCode: evaluation.currencyCode,
      inputFingerprint: fingerprints[index],
    })),
  }
}

// One active line, one PRIMARY diagnosis, one pointer, the same exact PRICED run: the §13 happy path.
function reviewable(): DraftSnapshot {
  const lines = [{ id: LINE1, sequence: 1, sources: [source(ACT1)] }]
  return {
    lineage: {
      claimId: CLAIM,
      claimContractVersion: 'A6-CLAIM-1',
      handoffSchemaVersion: 'PreClaimA6HandoffV1',
      readinessAssessmentId: id(7),
      validationRunId: id(8),
      serviceDate: '2026-06-15',
      facilityRegulatoryProfileId: id(9),
      providerContractId: CONTRACT,
      tariffScheduleId: SCHEDULE,
      tariffScheduleVersionId: VERSION,
    },
    claimEncounterId: ENCOUNTER,
    handoff: { ok: true, schemaVersion: 'PreClaimA6HandoffV1', readinessAssessmentId: id(7), encounterId: ENCOUNTER, encounterActivityIds: new Set([ACT1, ACT2]), encounterDiagnosisIds: new Set([EDX1, EDX2]) },
    lines,
    diagnoses: [{ id: DX1, sequence: 1, encounterDiagnosisId: EDX1, roleCode: 'PRIMARY', sourceEncounterId: ENCOUNTER, sourceRemoved: false }],
    pointers: [{ id: id(61), claimLineId: LINE1, claimDiagnosisId: DX1, diagnosisClaimId: CLAIM, diagnosisRemoved: false }],
    pricing: priceWithOwner(lines.map((line) => ({ id: line.id, sequence: line.sequence, source: line.sources[0] }))),
  }
}

const codes = (snapshot: DraftSnapshot) => evaluateDraft(snapshot).findings.map((finding) => finding.findingCode)
const blockers = (snapshot: DraftSnapshot) => evaluateDraft(snapshot).findings.filter((finding) => finding.severity === 'BLOCKER').map((finding) => finding.findingCode)

test('REVIEWABLE: one line, one PRIMARY, one pointer and the exact unchanged PRICED run; the only finding is the advisory', () => {
  const result = evaluateDraft(reviewable())
  assert.equal(result.outcome, 'REVIEWABLE')
  assert.deepEqual(codes(reviewable()), ['CLAIM_DRAFT_JURISDICTION_RULES_NOT_EVALUATED'])
  assert.equal(result.findings[0].severity, 'ADVISORY')
  assert.equal(result.findings[0].ordinal, 1)
})

test('INCOMPLETE keeps every relevant code: no lines, no diagnoses, no pointer and no pricing run', () => {
  const snapshot = { ...reviewable(), lines: [], diagnoses: [], pointers: [], pricing: null }
  const result = evaluateDraft(snapshot)
  assert.equal(result.outcome, 'INCOMPLETE')
  assert.deepEqual(blockers(snapshot), ['CLAIM_DRAFT_NO_LINES', 'CLAIM_DRAFT_NO_DIAGNOSES', 'CLAIM_DRAFT_PRICING_RUN_MISSING'])
  const noPointer = { ...reviewable(), pointers: [] }
  assert.deepEqual(blockers(noPointer), ['CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING'])
  assert.equal(evaluateDraft(noPointer).outcome, 'INCOMPLETE')
})

test('PRIMARY count: none is INCOMPLETE, two is INVALID with both named, and no winner is chosen', () => {
  const none = reviewable()
  none.diagnoses = [{ ...none.diagnoses[0], roleCode: 'SECONDARY' }]
  assert.deepEqual(blockers(none), ['CLAIM_DRAFT_PRIMARY_ROLE_MISSING'])
  const two = reviewable()
  two.diagnoses = [two.diagnoses[0], { id: DX2, sequence: 2, encounterDiagnosisId: EDX2, roleCode: 'PRIMARY', sourceEncounterId: ENCOUNTER, sourceRemoved: false }]
  const result = evaluateDraft(two)
  assert.equal(result.outcome, 'INVALID')
  assert.deepEqual(
    result.findings.filter((finding) => finding.findingCode === 'CLAIM_DRAFT_PRIMARY_ROLE_MULTIPLE').map((finding) => finding.relatedClaimDiagnosisId),
    [DX1, DX2],
  )
})

test('an ADMITTING diagnosis is an explicit unsupported-rule gap, never a pass', () => {
  const snapshot = reviewable()
  snapshot.diagnoses.push({ id: DX2, sequence: 2, encounterDiagnosisId: EDX2, roleCode: 'ADMITTING', sourceEncounterId: ENCOUNTER, sourceRemoved: false })
  assert.deepEqual(blockers(snapshot), ['CLAIM_DRAFT_UNSUPPORTED_RULE'])
  assert.equal(evaluateDraft(snapshot).outcome, 'INCOMPLETE')
})

test('pointer corruption: a cross-Claim, removed-target or duplicated active pointer is INVALID', () => {
  const crossClaim = reviewable()
  crossClaim.pointers = [{ ...crossClaim.pointers[0], diagnosisClaimId: id(999) }]
  assert.ok(codes(crossClaim).includes('CLAIM_DRAFT_POINTER_CORRUPT'))
  assert.equal(evaluateDraft(crossClaim).outcome, 'INVALID')
  const removedTarget = reviewable()
  removedTarget.pointers = [{ ...removedTarget.pointers[0], diagnosisRemoved: true }]
  assert.equal(evaluateDraft(removedTarget).outcome, 'INVALID')
  const duplicated = reviewable()
  duplicated.pointers = [duplicated.pointers[0], { ...duplicated.pointers[0], id: id(62) }]
  assert.deepEqual(blockers(duplicated), ['CLAIM_DRAFT_POINTER_CORRUPT'])
})

test('a stored order gap is INVALID, never repaired', () => {
  const snapshot = reviewable()
  snapshot.lines = [{ ...snapshot.lines[0], sequence: 5 }]
  assert.ok(codes(snapshot).includes('CLAIM_DRAFT_ORDER_CORRUPT'))
  assert.equal(evaluateDraft(snapshot).outcome, 'INVALID')
})

test('a line source outside the bound handoff or Encounter is INVALID; a removed source is STALE', () => {
  const outside = reviewable()
  outside.handoff = { ...(outside.handoff as Extract<DraftSnapshot['handoff'], { ok: true }>), encounterActivityIds: new Set([ACT2]) }
  assert.ok(codes(outside).includes('CLAIM_DRAFT_LINE_SOURCE_INVALID'))
  const removed = reviewable()
  removed.lines = [{ ...removed.lines[0], sources: [source(ACT1, { removed: true })] }]
  assert.deepEqual(blockers(removed), ['CLAIM_DRAFT_SOURCE_STALE'])
  assert.equal(evaluateDraft(removed).outcome, 'STALE')
})

test('a refused handoff is INVALID and keeps the other findings', () => {
  const snapshot = { ...reviewable(), handoff: { ok: false as const, refusal: 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' }, pricing: null }
  const result = evaluateDraft(snapshot)
  assert.equal(result.outcome, 'INVALID')
  assert.deepEqual(blockers(snapshot), ['CLAIM_DRAFT_HANDOFF_INVALID', 'CLAIM_DRAFT_PRICING_RUN_MISSING'])
})

test('source drift after pricing is STALE even when the total would be unchanged', () => {
  const quantity = reviewable()
  quantity.lines = [{ ...quantity.lines[0], sources: [source(ACT1, { quantity: D('2') })] }]
  assert.deepEqual(blockers(quantity), ['CLAIM_DRAFT_SOURCE_STALE'])
  const modifier = reviewable()
  modifier.lines = [{ ...modifier.lines[0], sources: [source(ACT1, { modifierCodes: ['M1'] })] }]
  assert.deepEqual(blockers(modifier), ['CLAIM_DRAFT_SOURCE_STALE'])
  const unit = reviewable()
  unit.lines = [{ ...unit.lines[0], sources: [source(ACT1, { unitCode: 'SYN-U' })] }]
  assert.equal(evaluateDraft(unit).outcome, 'STALE')
})

test('sourceMatchesPricing agrees with the A6.3 fingerprint for priced, missing-rate and invalid-source lines', () => {
  const snapshot = reviewable()
  const pricing = snapshot.pricing as SnapshotPricing
  assert.equal(sourceMatchesPricing(snapshot.lines[0].sources[0], pricing.lines[0], VERSION), true)
  const missing = priceWithOwner([{ id: LINE1, sequence: 1, source: source(ACT1, { procedureCodeId: id(777) }) }])
  assert.equal(missing.lines[0].outcome, 'UNPRICED_RATE_MISSING')
  assert.equal(sourceMatchesPricing(source(ACT1, { procedureCodeId: id(777) }), missing.lines[0], VERSION), true)
  assert.equal(sourceMatchesPricing(source(ACT1, { procedureCodeId: id(778) }), missing.lines[0], VERSION), false)
  const invalid = priceWithOwner([{ id: LINE1, sequence: 1, source: source(ACT1, { removed: true }) }])
  assert.equal(invalid.lines[0].outcome, 'UNPRICED_SOURCE_INVALID')
  assert.equal(sourceMatchesPricing(source(ACT1, { removed: true }), invalid.lines[0], VERSION), true)
})

test('a line added or removed after pricing makes the run STALE; it is never re-priced', () => {
  const added = reviewable()
  added.lines.push({ id: LINE2, sequence: 2, sources: [source(ACT2)] })
  added.pointers.push({ id: id(63), claimLineId: LINE2, claimDiagnosisId: DX1, diagnosisClaimId: CLAIM, diagnosisRemoved: false })
  const result = evaluateDraft(added)
  assert.equal(result.outcome, 'STALE')
  assert.deepEqual(
    result.findings.filter((finding) => finding.findingCode === 'CLAIM_DRAFT_PRICING_STALE').map((finding) => finding.relatedClaimLineId),
    [LINE2],
  )
  const twoLines = reviewable()
  twoLines.lines.push({ id: LINE2, sequence: 2, sources: [source(ACT2)] })
  twoLines.pricing = priceWithOwner(twoLines.lines.map((line) => ({ id: line.id, sequence: line.sequence, source: line.sources[0] })))
  twoLines.lines = [twoLines.lines[0]]
  assert.deepEqual(blockers(twoLines), ['CLAIM_DRAFT_PRICING_STALE'])
})

test('a reorder after pricing is structure drift, not source drift', () => {
  const snapshot = reviewable()
  snapshot.lines.push({ id: LINE2, sequence: 2, sources: [source(ACT2)] })
  snapshot.pointers.push({ id: id(63), claimLineId: LINE2, claimDiagnosisId: DX1, diagnosisClaimId: CLAIM, diagnosisRemoved: false })
  snapshot.pricing = priceWithOwner(snapshot.lines.map((line) => ({ id: line.id, sequence: line.sequence, source: line.sources[0] })))
  assert.equal(evaluateDraft(snapshot).outcome, 'REVIEWABLE')
  snapshot.lines = [
    { ...snapshot.lines[1], sequence: 1 },
    { ...snapshot.lines[0], sequence: 2 },
  ]
  assert.deepEqual([...new Set(blockers(snapshot))], ['CLAIM_DRAFT_STRUCTURE_STALE'])
})

test('pricing coverage: an INCOMPLETE run is INCOMPLETE; a run of other commercial lineage is INVALID', () => {
  const incomplete = reviewable()
  incomplete.pricing = priceWithOwner([{ id: LINE1, sequence: 1, source: source(ACT1, { procedureCodeId: id(777) }) }])
  incomplete.lines = [{ ...incomplete.lines[0], sources: [source(ACT1, { procedureCodeId: id(777) })] }]
  assert.deepEqual(blockers(incomplete), ['CLAIM_DRAFT_PRICING_INCOMPLETE'])
  const mismatch = reviewable()
  mismatch.lineage = { ...mismatch.lineage, tariffScheduleVersionId: id(555) }
  assert.ok(codes(mismatch).includes('CLAIM_DRAFT_COMMERCIAL_MISMATCH'))
  assert.equal(evaluateDraft(mismatch).outcome, 'INVALID')
  const nullLineage = reviewable()
  nullLineage.lineage = { ...nullLineage.lineage, providerContractId: null }
  assert.equal(evaluateDraft(nullLineage).outcome, 'INVALID')
})

test('a stored run that does not hold its own fingerprint or counts is INVALID', () => {
  const tampered = reviewable()
  const pricing = tampered.pricing as SnapshotPricing
  tampered.pricing = { ...pricing, inputStructureFingerprint: 'f'.repeat(64) }
  assert.ok(codes(tampered).includes('CLAIM_DRAFT_PRICING_INTEGRITY'))
  const counts = reviewable()
  counts.pricing = { ...(counts.pricing as SnapshotPricing), lineCount: 2 }
  assert.equal(evaluateDraft(counts).outcome, 'INVALID')
})

test('precedence INVALID > STALE > INCOMPLETE > REVIEWABLE; advisories never reduce', () => {
  const of = (...list: FindingCode[]) => reduceOutcome(list.map((findingCode) => ({ findingCode })))
  assert.equal(of('CLAIM_DRAFT_NO_LINES', 'CLAIM_DRAFT_SOURCE_STALE', 'CLAIM_DRAFT_POINTER_CORRUPT'), 'INVALID')
  assert.equal(of('CLAIM_DRAFT_NO_LINES', 'CLAIM_DRAFT_PRICING_STALE'), 'STALE')
  assert.equal(of('CLAIM_DRAFT_PRICING_INCOMPLETE', 'CLAIM_DRAFT_JURISDICTION_RULES_NOT_EVALUATED'), 'INCOMPLETE')
  assert.equal(of('CLAIM_DRAFT_JURISDICTION_RULES_NOT_EVALUATED'), 'REVIEWABLE')
  assert.equal(of(), 'REVIEWABLE')
})

test('every catalogue code has a fixed class and owner scope; ordinals are 1..N in a stable order', () => {
  for (const code of findingCodes) assert.ok(findingCatalogue[code].class && findingCatalogue[code].scope)
  const snapshot = { ...reviewable(), lines: [], diagnoses: [], pointers: [], pricing: null }
  const first = evaluateDraft(snapshot).findings
  assert.deepEqual(first.map((finding) => finding.ordinal), first.map((_, index) => index + 1))
  const reversed = { ...snapshot, pointers: [...snapshot.pointers].reverse() }
  assert.deepEqual(evaluateDraft(reversed).findings, first)
})

test('fingerprint: stable on equal state, independent of set order, sensitive to review-relevant change', () => {
  const base = assemblyFingerprint(reviewable())
  assert.match(base, /^[0-9a-f]{64}$/)
  assert.equal(assemblyFingerprint(reviewable()), base)
  const twoPointers = reviewable()
  twoPointers.diagnoses.push({ id: DX2, sequence: 2, encounterDiagnosisId: EDX2, roleCode: 'SECONDARY', sourceEncounterId: ENCOUNTER, sourceRemoved: false })
  twoPointers.pointers.push({ id: id(64), claimLineId: LINE1, claimDiagnosisId: DX2, diagnosisClaimId: CLAIM, diagnosisRemoved: false })
  const shuffled = { ...twoPointers, pointers: [...twoPointers.pointers].reverse() }
  assert.equal(assemblyFingerprint(shuffled), assemblyFingerprint(twoPointers))
  const changes: ((s: DraftSnapshot) => void)[] = [
    (s) => (s.lines[0].sources[0] = source(ACT1, { quantity: D('1.5001') })),
    (s) => (s.lines[0].sources[0] = source(ACT1, { modifierCodes: ['M1'] })),
    (s) => (s.diagnoses[0] = { ...s.diagnoses[0], roleCode: 'SECONDARY' }),
    (s) => (s.diagnoses[0] = { ...s.diagnoses[0], sequence: 2 }),
    (s) => (s.pointers = []),
    (s) => (s.pricing = null),
    (s) => (s.lineage = { ...s.lineage, facilityRegulatoryProfileId: id(1000) }),
  ]
  for (const change of changes) {
    const changed = reviewable()
    change(changed)
    assert.notEqual(assemblyFingerprint(changed), base)
  }
})

test('the decimal text is exact and locale-free; floats and undefined are refused by the canonical serializer', () => {
  const a = reviewable()
  const b = reviewable()
  b.lines[0].sources[0] = source(ACT1, { quantity: D('1.50') })
  assert.equal(assemblyFingerprint(a), assemblyFingerprint(b))
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}')
  assert.throws(() => canonicalJson({ amount: 1.5 }))
  assert.throws(() => canonicalJson({ missing: undefined }))
})

test('request shapes: exactly { pricingRunId } for an assessment; one optional pricingRunId for a preview', () => {
  assert.equal(validateCreateAssessmentBody({ pricingRunId: CLAIM }).ok, true)
  assert.equal(validateCreateAssessmentBody({}).ok, false)
  assert.equal(validateCreateAssessmentBody({ pricingRunId: 'nope' }).ok, false)
  assert.equal(validateCreateAssessmentBody({ pricingRunId: CLAIM, outcome: 'REVIEWABLE' }).ok, false)
  assert.equal(validateCreateAssessmentBody({ pricingRunId: CLAIM, extra: 1 }).ok, false)
  assert.equal(validateCreateAssessmentBody([CLAIM]).ok, false)
  assert.deepEqual(validatePreviewQuery({}), { ok: true, value: { pricingRunId: null } })
  assert.deepEqual(validatePreviewQuery({ pricingRunId: CLAIM }), { ok: true, value: { pricingRunId: CLAIM } })
  assert.equal(validatePreviewQuery({ pricingRunId: [CLAIM, CLAIM] }).ok, false)
  assert.equal(validatePreviewQuery({ latest: 'true' }).ok, false)
})
