import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveCasePrerequisite, recordedAssessmentAgrees } from './case-prerequisite.reducer.ts'
import { BASIS_OF, assessmentCodes, basisCodes, type CaseHeaderFacts, type CaseItemFacts, type ReadinessFacts } from './case-prerequisite.types.ts'

// A7.5 — the pure case-level reducer. Synthetic values only.

const DIGEST = '46f333ef'.padEnd(64, '0')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOT_READY = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }
const REVIEW = { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' }
const UNSUPPORTED = { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }

// A linked item n has source 1n, classification 2n and readiness 3n.
const linked = (n: number): CaseItemFacts => ({ ordinal: n, sourceEvidenceId: id(100 + n), classificationId: id(200 + n), readinessId: id(300 + n), itemReasonCode: 'LINKED' })
const sourceOnly = (n: number): CaseItemFacts => ({ ordinal: n, sourceEvidenceId: id(100 + n), classificationId: null, readinessId: null, itemReasonCode: 'SOURCE_ONLY' })
const classifiedOnly = (n: number): CaseItemFacts => ({ ordinal: n, sourceEvidenceId: id(100 + n), classificationId: id(200 + n), readinessId: null, itemReasonCode: 'CLASSIFIED_NO_READINESS' })
const gate = (n: number, pair = NOT_READY): ReadinessFacts => ({ readinessId: id(300 + n), classificationId: id(200 + n), sourceEvidenceId: id(100 + n), contractVersion: 'A7-ADJ-READINESS-1', ...pair })
const headerOf = (items: CaseItemFacts[], overrides: Partial<CaseHeaderFacts> = {}): CaseHeaderFacts => {
  const readinessCount = items.filter((i) => i.readinessId !== null).length
  return {
    contractVersion: 'A7-REVENUE-CASE-1',
    assemblyCode: items.length === 0 ? 'NO_REVENUE_SOURCES' : readinessCount === items.length ? 'INVENTORY_COMPLETE' : 'INVENTORY_INCOMPLETE',
    sourceCount: items.length,
    classifiedCount: items.filter((i) => i.classificationId !== null).length,
    readinessCount,
    itemCount: items.length,
    manifestSha256: DIGEST,
    ...overrides,
  }
}
const derive = (items: CaseItemFacts[], readiness: ReadinessFacts[], overrides: Partial<CaseHeaderFacts> = {}) => deriveCasePrerequisite(headerOf(items, overrides), items, readiness)
const outcome = (assessmentCode: string) => ({ ok: true, value: { assessmentCode, basisCode: BASIS_OF[assessmentCode as keyof typeof BASIS_OF] } })
const isConflict = (result: ReturnType<typeof deriveCasePrerequisite>) => !result.ok && result.refusal === 'PROVENANCE_CONFLICT'

test('five outcomes, each paired with exactly one basis, and no positive closure code', () => {
  assert.deepEqual(Object.keys(BASIS_OF), [...assessmentCodes])
  assert.deepEqual(Object.values(BASIS_OF), [...basisCodes])
  assert.equal([...assessmentCodes, ...basisCodes].some((code) => /READY_FOR|CLOSED|PAID|SETTLED|POSTED/.test(code)), false)
})

test('an empty case is NO_SOURCE_BASIS / NO_REGISTERED_SOURCES', () => {
  assert.deepEqual(derive([], []), outcome('NO_SOURCE_BASIS'))
  assert.equal(BASIS_OF.NO_SOURCE_BASIS, 'NO_REGISTERED_SOURCES')
})

test('an incomplete case is INCOMPLETE_SOURCE_CHAIN, whatever its linked items say', () => {
  assert.deepEqual(derive([linked(1), sourceOnly(2)], [gate(1)]), outcome('INCOMPLETE_SOURCE_CHAIN'))
  assert.deepEqual(derive([classifiedOnly(1)], []), outcome('INCOMPLETE_SOURCE_CHAIN'))
  assert.deepEqual(derive([linked(1), classifiedOnly(2)], [gate(1, REVIEW)]), outcome('INCOMPLETE_SOURCE_CHAIN'))
})

test('a complete synthetic case is EXTERNAL_FINANCIAL_EVIDENCE_ABSENT, never closure-ready', () => {
  assert.deepEqual(derive([linked(1), linked(2)], [gate(1), gate(2)]), outcome('EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'))
  assert.equal(BASIS_OF.EXTERNAL_FINANCIAL_EVIDENCE_ABSENT, 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED')
})

test('a complete case with a review readiness is REVIEW_REQUIRED, and review outranks unsupported', () => {
  assert.deepEqual(derive([linked(1), linked(2)], [gate(1), gate(2, REVIEW)]), outcome('REVIEW_REQUIRED'))
  assert.deepEqual(derive([linked(1), linked(2), linked(3)], [gate(1, UNSUPPORTED), gate(2, REVIEW), gate(3)]), outcome('REVIEW_REQUIRED'))
})

test('a complete case with an unsupported readiness and no review is UNSUPPORTED_SOURCE_BASIS', () => {
  assert.deepEqual(derive([linked(1), linked(2)], [gate(1), gate(2, UNSUPPORTED)]), outcome('UNSUPPORTED_SOURCE_BASIS'))
})

test('a missing, extra, foreign or uncontrolled readiness is a provenance conflict, never assumed ready', () => {
  const items = [linked(1), linked(2)]
  for (const readiness of [
    [gate(1)],
    [gate(1), gate(2), gate(3)],
    [gate(1), gate(1)],
    [gate(1), { ...gate(2), classificationId: id(201) }],
    [gate(1), { ...gate(2), sourceEvidenceId: id(101) }],
    [gate(1), { ...gate(2), contractVersion: 'A7-ADJ-READINESS-2' }],
    [gate(1), { ...gate(2), readinessCode: 'READY_FOR_ADJUDICATION' }],
    [gate(1), { ...gate(2), readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }],
    [gate(1), { ...gate(2), readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }],
  ]) {
    assert.equal(isConflict(derive(items, readiness)), true, JSON.stringify(readiness.at(-1)))
  }
})

test('a header or item that contradicts A7-REVENUE-CASE-1 is a provenance conflict', () => {
  const items = [linked(1), linked(2)]
  const ready = [gate(1), gate(2)]
  for (const overrides of [
    { contractVersion: 'A7-REVENUE-CASE-2' },
    { manifestSha256: DIGEST.toUpperCase() },
    { manifestSha256: 'abc' },
    { assemblyCode: 'INVENTORY_INCOMPLETE' },
    { assemblyCode: 'NO_REVENUE_SOURCES' },
    { assemblyCode: 'INVENTORY_READY' },
    { itemCount: 3 },
    { sourceCount: 1 },
    { classifiedCount: 1 },
    { readinessCount: 1 },
    { itemCount: -1, sourceCount: -1 },
  ]) {
    assert.equal(isConflict(derive(items, ready, overrides)), true, JSON.stringify(overrides))
  }
  assert.equal(isConflict(derive([], [], { assemblyCode: 'INVENTORY_COMPLETE' })), true)
  assert.equal(isConflict(derive([sourceOnly(1)], [], { assemblyCode: 'INVENTORY_COMPLETE' })), true)
  assert.equal(isConflict(derive([linked(2), linked(1)], ready)), true, 'ordinals out of order')
  assert.equal(isConflict(derive([linked(1), { ...linked(2), ordinal: 3 }], ready)), true, 'a gap')
  assert.equal(isConflict(derive([linked(1), { ...linked(2), sourceEvidenceId: id(101) }], [gate(1), { ...gate(2), sourceEvidenceId: id(101) }])), true, 'a repeated source')
  assert.equal(isConflict(derive([{ ...linked(1), itemReasonCode: 'SOURCE_ONLY' }], [gate(1)])), true, 'a reason that disagrees with its links')
  assert.equal(isConflict(derive([{ ...sourceOnly(1), itemReasonCode: 'SETTLED' }], [])), true, 'an uncontrolled reason')
  assert.equal(isConflict(derive([{ ...classifiedOnly(1), classificationId: 'not-a-uuid' }], [])), true, 'a malformed link')
})

test('fifty derivations of the same facts are identical', () => {
  const items = [linked(1), sourceOnly(2), linked(3)]
  const ready = [gate(1), gate(3, UNSUPPORTED)]
  const results = new Set(Array.from({ length: 50 }, () => JSON.stringify(derive(items, ready))))
  assert.equal(results.size, 1)
})

test('a recorded assessment agrees only when every derived field is identical', () => {
  const facts = { assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basisCode: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', caseManifestSha256: DIGEST, organizationId: id(9), contractVersion: 'A7-CLOSURE-PREREQ-1' }
  assert.equal(recordedAssessmentAgrees(facts, { ...facts }), true)
  for (const overrides of [{ assessmentCode: 'NO_SOURCE_BASIS' }, { basisCode: 'NO_REGISTERED_SOURCES' }, { caseManifestSha256: 'f'.repeat(64) }, { organizationId: id(8) }, { contractVersion: 'A7-CLOSURE-PREREQ-2' }]) {
    assert.equal(recordedAssessmentAgrees({ ...facts, ...overrides }, facts), false, JSON.stringify(overrides))
  }
})
