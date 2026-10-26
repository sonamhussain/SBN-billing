import test from 'node:test'
import assert from 'node:assert/strict'
import { BASIS_OF } from '../case-prerequisite/case-prerequisite.types.ts'
import { traceClosureBasis } from './closure-basis-trace.reducer.ts'
import type { CaseEntryFacts, ReadinessFacts, TraceFacts } from './closure-basis-trace.types.ts'

// A7.6 — the pure explanation reducer. Synthetic values only.

const DIGEST = '46f333ef'.padEnd(64, '0')
const ORG = '00000000-0000-4000-8000-000000000009'
const CASE = '00000000-0000-4000-8000-000000000001'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOT_READY = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }
const REVIEW = { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' }
const UNSUPPORTED = { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }

// Entry n has source 1n, classification 2n and readiness 3n.
const linked = (n: number): CaseEntryFacts => ({ ordinal: n, sourceEvidenceId: id(100 + n), classificationId: id(200 + n), readinessId: id(300 + n), itemReasonCode: 'LINKED' })
const sourceOnly = (n: number): CaseEntryFacts => ({ ordinal: n, sourceEvidenceId: id(100 + n), classificationId: null, readinessId: null, itemReasonCode: 'SOURCE_ONLY' })
const classifiedOnly = (n: number): CaseEntryFacts => ({ ordinal: n, sourceEvidenceId: id(100 + n), classificationId: id(200 + n), readinessId: null, itemReasonCode: 'CLASSIFIED_NO_READINESS' })
const gate = (n: number, pair = NOT_READY): ReadinessFacts => ({ readinessId: id(300 + n), classificationId: id(200 + n), sourceEvidenceId: id(100 + n), contractVersion: 'A7-ADJ-READINESS-1', ...pair })

const factsOf = (entries: CaseEntryFacts[], readiness: ReadinessFacts[], code: keyof typeof BASIS_OF, overrides: { header?: Partial<TraceFacts['header']>; assessment?: Partial<TraceFacts['assessment']>; sources?: string[] } = {}): TraceFacts => {
  const readinessCount = entries.filter((e) => e.readinessId !== null).length
  return {
    assessment: { assessmentId: id(900), caseId: CASE, organizationId: ORG, contractVersion: 'A7-CLOSURE-PREREQ-1', assessmentCode: code, basisCode: BASIS_OF[code], caseManifestSha256: DIGEST, ...overrides.assessment },
    header: {
      caseId: CASE,
      organizationId: ORG,
      contractVersion: 'A7-REVENUE-CASE-1',
      assemblyCode: entries.length === 0 ? 'NO_REVENUE_SOURCES' : readinessCount === entries.length ? 'INVENTORY_COMPLETE' : 'INVENTORY_INCOMPLETE',
      sourceCount: entries.length,
      classifiedCount: entries.filter((e) => e.classificationId !== null).length,
      readinessCount,
      itemCount: entries.length,
      manifestSha256: DIGEST,
      ...overrides.header,
    },
    entries,
    readiness,
    submissionSourceIds: overrides.sources ?? [...entries.map((e) => e.sourceEvidenceId), id(199)],
  }
}
const isConflict = (facts: TraceFacts) => {
  const result = traceClosureBasis(facts)
  return !result.ok && result.refusal === 'PROVENANCE_CONFLICT'
}
const explanations = (facts: TraceFacts) => {
  const result = traceClosureBasis(facts)
  return result.ok ? [result.value.traceCode, ...result.value.traceItems.map((i) => i.explanationCode)] : ['CONFLICT']
}

test('the worked complete case: EXTERNAL_FINANCIAL_EVIDENCE_ABSENT, one item per entry in order', () => {
  const result = traceClosureBasis(factsOf([linked(1), linked(2)], [gate(1), gate(2)], 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.traceCode, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT')
  assert.deepEqual(result.value.traceItems, [
    { ordinal: 1, sourceEvidenceId: id(101), classificationId: id(201), readinessId: id(301), sourceReasonCode: 'LINKED', readinessCode: 'NOT_READY_FOR_ADJUDICATION', readinessReasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', explanationCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' },
    { ordinal: 2, sourceEvidenceId: id(102), classificationId: id(202), readinessId: id(302), sourceReasonCode: 'LINKED', readinessCode: 'NOT_READY_FOR_ADJUDICATION', readinessReasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', explanationCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' },
  ])
})

test('an empty case is NO_SOURCE_BASIS with zero items', () => {
  assert.deepEqual(explanations(factsOf([], [], 'NO_SOURCE_BASIS')), ['NO_SOURCE_BASIS'])
})

test('missing links stay null and explain an incomplete chain', () => {
  const result = traceClosureBasis(factsOf([sourceOnly(1), classifiedOnly(2), linked(3)], [gate(3)], 'INCOMPLETE_SOURCE_CHAIN'))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.traceItems.map((i) => [i.explanationCode, i.classificationId, i.readinessId, i.readinessCode, i.readinessReasonCode]), [
    ['SOURCE_UNCLASSIFIED', null, null, null, null],
    ['CLASSIFICATION_NO_READINESS', id(202), null, null, null],
    ['EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', id(203), id(303), 'NOT_READY_FOR_ADJUDICATION', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT'],
  ])
})

test('review and unsupported items explain their outcomes, review first', () => {
  assert.deepEqual(explanations(factsOf([linked(1), linked(2)], [gate(1), gate(2, REVIEW)], 'REVIEW_REQUIRED')), ['REVIEW_REQUIRED', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_REVIEW_REQUIRED'])
  assert.deepEqual(explanations(factsOf([linked(1), linked(2)], [gate(1), gate(2, UNSUPPORTED)], 'UNSUPPORTED_SOURCE_BASIS')), ['UNSUPPORTED_SOURCE_BASIS', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_UNSUPPORTED'])
  assert.deepEqual(explanations(factsOf([linked(1), linked(2)], [gate(1, UNSUPPORTED), gate(2, REVIEW)], 'REVIEW_REQUIRED'))[0], 'REVIEW_REQUIRED')
  assert.equal(isConflict(factsOf([linked(1), linked(2)], [gate(1, UNSUPPORTED), gate(2, REVIEW)], 'UNSUPPORTED_SOURCE_BASIS')), true, 'unsupported never outranks review')
})

test('the trace never replaces the recorded outcome: a different recorded code or basis is a conflict', () => {
  const entries = [linked(1), linked(2)]
  const ready = [gate(1), gate(2)]
  for (const code of ['NO_SOURCE_BASIS', 'INCOMPLETE_SOURCE_CHAIN', 'REVIEW_REQUIRED', 'UNSUPPORTED_SOURCE_BASIS'] as const) assert.equal(isConflict(factsOf(entries, ready, code)), true, code)
  assert.equal(isConflict(factsOf(entries, ready, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', { assessment: { basisCode: 'NO_REGISTERED_SOURCES' } })), true)
  assert.equal(isConflict(factsOf(entries, ready, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', { assessment: { assessmentCode: 'READY_FOR_CLOSURE' } })), true)
})

test('the assessment must be the exact A7-CLOSURE-PREREQ-1 record of exactly this case and its digest', () => {
  const ok = (o: Parameters<typeof factsOf>[3]) => factsOf([linked(1)], [gate(1)], 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', o)
  assert.equal(isConflict(ok({})), false)
  for (const assessment of [{ contractVersion: 'A7-CLOSURE-PREREQ-2' }, { caseId: id(2) }, { organizationId: id(8) }, { caseManifestSha256: 'f'.repeat(64) }]) assert.equal(isConflict(ok({ assessment })), true, JSON.stringify(assessment))
  for (const header of [{ contractVersion: 'A7-REVENUE-CASE-2' }, { manifestSha256: DIGEST.toUpperCase() }]) assert.equal(isConflict(ok({ header })), true, JSON.stringify(header))
})

test('counts, ordinals, sources, link shapes and assembly code must agree with the stored entries', () => {
  const entries = [linked(1), linked(2)]
  const ready = [gate(1), gate(2)]
  const conflictWith = (header: Partial<TraceFacts['header']>, e = entries, r = ready, sources?: string[]) => isConflict(factsOf(e, r, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', { header, sources }))
  for (const header of [{ sourceCount: 3 }, { itemCount: 3 }, { classifiedCount: 1 }, { readinessCount: 1 }, { assemblyCode: 'INVENTORY_INCOMPLETE' }, { assemblyCode: 'NO_REVENUE_SOURCES' }, { assemblyCode: 'INVENTORY_READY' }]) assert.equal(conflictWith(header), true, JSON.stringify(header))
  assert.equal(conflictWith({}, [linked(2), linked(1)]), true, 'reversed order')
  assert.equal(conflictWith({}, [linked(1), { ...linked(2), ordinal: 3 }]), true, 'a gap')
  assert.equal(conflictWith({}, [linked(1), { ...linked(2), ordinal: 1 }]), true, 'a repeated ordinal')
  assert.equal(conflictWith({}, [linked(1), { ...linked(2), sourceEvidenceId: id(101) }], [gate(1), { ...gate(2), sourceEvidenceId: id(101) }]), true, 'a repeated source')
  assert.equal(conflictWith({}, entries, ready, [id(101)]), true, 'a source that is not the submission registration')
  assert.equal(isConflict(factsOf([{ ...sourceOnly(1), readinessId: id(301) }], [], 'INCOMPLETE_SOURCE_CHAIN')), true, 'a readiness without a classification')
  assert.equal(isConflict(factsOf([{ ...sourceOnly(1), itemReasonCode: 'SETTLED' }], [], 'INCOMPLETE_SOURCE_CHAIN')), true, 'an uncontrolled reason')
  assert.equal(isConflict(factsOf([sourceOnly(1)], [], 'INCOMPLETE_SOURCE_CHAIN', { header: { assemblyCode: 'NO_REVENUE_SOURCES' } })), true, 'NO_REVENUE_SOURCES with items')
})

test('a missing, duplicated, foreign or uncontrolled readiness is refused, never guessed', () => {
  const entries = [linked(1), linked(2)]
  for (const readiness of [
    [gate(1)],
    [gate(1), gate(2), { ...gate(2), readinessId: id(399) }],
    [gate(1), gate(2), gate(3)],
    [gate(1), { ...gate(2), readinessId: id(398) }],
    [gate(1), { ...gate(2), sourceEvidenceId: id(101) }],
    [gate(1), { ...gate(2), contractVersion: 'A7-ADJ-READINESS-2' }],
    [gate(1), { ...gate(2), readinessCode: 'READY_FOR_ADJUDICATION' }],
    [gate(1), { ...gate(2), reasonCode: 'PAYER_CONFIRMED' }],
    [gate(1), { ...gate(2), readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }],
  ]) {
    assert.equal(isConflict(factsOf(entries, readiness, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT')), true, JSON.stringify(readiness.at(-1)))
  }
  assert.equal(isConflict(factsOf([linked(1), { ...linked(2), readinessId: id(301) }], [gate(1), gate(2)], 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT')), true, 'two entries name one readiness')
  assert.equal(isConflict(factsOf([linked(1), { ...linked(2), classificationId: id(201) }], [gate(1)], 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT')), true, 'a linked entry with another source classification')
})

test('fifty reductions of the same facts are identical', () => {
  const facts = factsOf([linked(1), sourceOnly(2), linked(3)], [gate(1), gate(3, UNSUPPORTED)], 'INCOMPLETE_SOURCE_CHAIN')
  assert.equal(new Set(Array.from({ length: 50 }, () => JSON.stringify(traceClosureBasis(facts)))).size, 1)
})
