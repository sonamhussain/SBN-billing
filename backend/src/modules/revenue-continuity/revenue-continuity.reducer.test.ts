import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveRevenueContinuity } from './revenue-continuity.reducer.ts'
import { deriveRevenueDelta } from '../revenue-delta/revenue-delta.reducer.ts'
import type { TimelineCaseFacts, TimelineEntryFacts, TimelineFacts } from '../revenue-delta/revenue-delta.types.ts'
import type { DeltaFacts } from './revenue-continuity.types.ts'

// A7.9 — the pure continuity reducer. Synthetic values only. The matching delta is always the one the accepted A7.8
// reducer derives from the same timeline, so a test never invents a second delta.

const CLAIM = '00000000-0000-4000-8000-0000000000c1'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const digest = (n: number) => String(n).padStart(64, 'a')
const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString()
const OUTCOME = {
  NO_SOURCE_BASIS: 'NO_REGISTERED_SOURCES',
  INCOMPLETE_SOURCE_CHAIN: 'SOURCE_LINKS_INCOMPLETE',
  REVIEW_REQUIRED: 'EVIDENCE_REVIEW_REQUIRED',
  UNSUPPORTED_SOURCE_BASIS: 'UNSUPPORTED_EVIDENCE',
  EXTERNAL_FINANCIAL_EVIDENCE_ABSENT: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED',
} as const
type Outcome = keyof typeof OUTCOME
const caseOf = (n: number, overrides: Partial<TimelineCaseFacts> = {}): TimelineCaseFacts => ({
  caseId: id(300 + n), contractVersion: 'A7-REVENUE-CASE-1', assemblyCode: 'INVENTORY_COMPLETE', sourceCount: 2, classifiedCount: 2, readinessCount: 2, itemCount: 2, manifestSha256: digest(n), ...overrides,
})
// Entry n is freeze 1n frozen at second n, linked from freeze n-1 by link 2n; `state` is none, a case, or an assessed case.
const entry = (n: number, state: 'none' | 'case' | Outcome = 'none'): TimelineEntryFacts => {
  const c = state === 'none' ? null : caseOf(n)
  return {
    ordinal: n, claimSubmissionId: id(100 + n), priorSubmissionId: n === 1 ? null : id(99 + n), correctionLinkId: n === 1 ? null : id(200 + n), frozenAt: at(n),
    caseSummaries: c ? [c] : [],
    prerequisiteSummaries: c && state !== 'case' ? [{ assessmentId: id(400 + n), caseId: c.caseId, contractVersion: 'A7-CLOSURE-PREREQ-1', assessmentCode: state, basisCode: OUTCOME[state as Outcome], caseManifestSha256: c.manifestSha256 }] : [],
  }
}
const timeline = (entries: TimelineEntryFacts[], overrides: Partial<TimelineFacts> = {}): TimelineFacts => ({
  contractVersion: 'A7-REVENUE-TIMELINE-1', claimId: CLAIM, chainCode: entries.length === 0 ? 'NO_FROZEN_SUBMISSION' : 'LINEAR_HISTORY', submissions: entries, historyCount: entries.length, ...overrides,
})
const deltaOf = (input: TimelineFacts): DeltaFacts => {
  const result = deriveRevenueDelta(input)
  if (!result.ok) throw new Error(result.detail)
  return { contractVersion: 'A7-REVENUE-DELTA-1', claimId: input.claimId, baselineCode: result.value.baselineCode, comparisonCount: result.value.comparisons.length, comparisons: result.value.comparisons }
}
const summary = (input: TimelineFacts, delta: DeltaFacts = deltaOf(input)) => {
  const result = deriveRevenueContinuity(input, delta)
  return result.ok ? [result.value.continuityCode, ...result.value.gaps.map((g) => g.gapCode)] : ['CONFLICT', result.detail]
}

test('zero, one, two and four freezes give the code, the counts and one gap per freeze', () => {
  const zero = deriveRevenueContinuity(timeline([]), deltaOf(timeline([])))
  assert.deepEqual(zero.ok && [zero.value.continuityCode, zero.value.submissionCount, zero.value.comparisonCount, zero.value.gaps], ['NO_FROZEN_SUBMISSION', 0, 0, []])
  const one = deriveRevenueContinuity(timeline([entry(1)]), deltaOf(timeline([entry(1)])))
  assert.deepEqual(one.ok && [one.value.continuityCode, one.value.submissionCount, one.value.comparisonCount, one.value.gaps.length], ['SINGLE_FREEZE_NO_COMPARISON', 1, 0, 1])
  const two = timeline([entry(1, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'), entry(2, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT')])
  const twoResult = deriveRevenueContinuity(two, deltaOf(two))
  assert.deepEqual(twoResult.ok && [twoResult.value.submissionCount, twoResult.value.comparisonCount], [2, 1])
  const four = timeline([entry(1), entry(2), entry(3), entry(4)])
  const fourResult = deriveRevenueContinuity(four, deltaOf(four))
  assert.deepEqual(fourResult.ok && [fourResult.value.submissionCount, fourResult.value.comparisonCount, fourResult.value.gaps.map((g) => g.ordinal)], [4, 3, [1, 2, 3, 4]])
})

test('the worked example: no case, unassessed, external absent, incomplete chain', () => {
  const input = timeline([entry(1), entry(2, 'case'), entry(3, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'), entry(4, 'INCOMPLETE_SOURCE_CHAIN')])
  const result = deriveRevenueContinuity(input, deltaOf(input))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.continuityCode, 'HISTORICAL_EVIDENCE_UNRECORDED')
  assert.deepEqual(result.value.gaps, [
    { ordinal: 1, claimSubmissionId: id(101), caseId: null, assessmentId: null, gapCode: 'CASE_NOT_RECORDED', basisCode: null },
    { ordinal: 2, claimSubmissionId: id(102), caseId: id(302), assessmentId: null, gapCode: 'PREREQUISITE_NOT_RECORDED', basisCode: null },
    { ordinal: 3, claimSubmissionId: id(103), caseId: id(303), assessmentId: id(403), gapCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basisCode: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' },
    { ordinal: 4, claimSubmissionId: id(104), caseId: id(304), assessmentId: id(404), gapCode: 'SOURCE_CHAIN_INCOMPLETE', basisCode: 'SOURCE_LINKS_INCOMPLETE' },
  ])
  // A fifth freeze appended later leaves every earlier gap identical.
  const grown = timeline([...input.submissions, entry(5)])
  const after = deriveRevenueContinuity(grown, deltaOf(grown))
  assert.deepEqual(after.ok && after.value.gaps.slice(0, 4), result.value.gaps)
  assert.deepEqual(after.ok && after.value.gaps[4].gapCode, 'CASE_NOT_RECORDED')
})

test('every A7.5 outcome maps to its own gap and keeps its exact basis', () => {
  const pairs: [Outcome, string][] = [
    ['NO_SOURCE_BASIS', 'NO_SOURCE_BASIS'],
    ['INCOMPLETE_SOURCE_CHAIN', 'SOURCE_CHAIN_INCOMPLETE'],
    ['REVIEW_REQUIRED', 'REVIEW_REQUIRED'],
    ['UNSUPPORTED_SOURCE_BASIS', 'UNSUPPORTED_SOURCE'],
    ['EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'],
  ]
  for (const [outcome, gap] of pairs) {
    const input = timeline([entry(1, outcome), entry(2, outcome)])
    const result = deriveRevenueContinuity(input, deltaOf(input))
    assert.deepEqual(result.ok && [result.value.continuityCode, result.value.gaps[0].gapCode, result.value.gaps[0].basisCode], ['HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF', gap, OUTCOME[outcome]], outcome)
  }
})

test('fixed priority: zero, single, unrecorded, unassessed, all recorded', () => {
  assert.deepEqual(summary(timeline([entry(1)])), ['SINGLE_FREEZE_NO_COMPARISON', 'CASE_NOT_RECORDED'])
  assert.deepEqual(summary(timeline([entry(1, 'case')])), ['SINGLE_FREEZE_NO_COMPARISON', 'PREREQUISITE_NOT_RECORDED'])
  assert.deepEqual(summary(timeline([entry(1, 'case'), entry(2)])), ['HISTORICAL_EVIDENCE_UNRECORDED', 'PREREQUISITE_NOT_RECORDED', 'CASE_NOT_RECORDED'])
  assert.deepEqual(summary(timeline([entry(1, 'REVIEW_REQUIRED'), entry(2, 'case')])), ['HISTORICAL_EVIDENCE_UNASSESSED', 'REVIEW_REQUIRED', 'PREREQUISITE_NOT_RECORDED'])
  assert.deepEqual(summary(timeline([entry(1, 'REVIEW_REQUIRED'), entry(2, 'UNSUPPORTED_SOURCE_BASIS')])), ['HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF', 'REVIEW_REQUIRED', 'UNSUPPORTED_SOURCE'])
})

test('a delta that disagrees with the timeline is a provenance conflict, never a partial result', () => {
  const input = timeline([entry(1), entry(2, 'case'), entry(3, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'), entry(4)])
  const good = deltaOf(input)
  const [c1, c2, c3] = good.comparisons
  const vectors: [string, DeltaFacts][] = [
    ['future A7.8 contract', { ...good, contractVersion: 'A7-REVENUE-DELTA-2' }],
    ['another claim', { ...good, claimId: id(999) }],
    ['wrong baseline', { ...good, baselineCode: 'SINGLE_FREEZE' }],
    ['missing pair', { ...good, comparisonCount: 2, comparisons: [c1, c2] }],
    ['duplicate pair', { ...good, comparisons: [c1, c2, { ...c2, ordinal: 3 }] }],
    ['reversed pair', { ...good, comparisons: [c1, { ...c2, predecessorSubmissionId: c2.correctedSubmissionId, correctedSubmissionId: c2.predecessorSubmissionId }, c3] }],
    ['ordinal gap', { ...good, comparisons: [c1, { ...c2, ordinal: 3 }, c3] }],
    ['wrong link', { ...good, comparisons: [c1, { ...c2, correctionLinkId: id(777) }, c3] }],
    ['another instant', { ...good, comparisons: [c1, { ...c2, correctedFrozenAt: at(59) }, c3] }],
    ['uncontrolled delta code', { ...good, comparisons: [c1, { ...c2, evidenceDeltaCode: 'PAID' }, c3] }],
    ['another case', { ...good, comparisons: [c1, { ...c2, predecessorCaseId: id(888) }, c3] }],
    ['invented assessment', { ...good, comparisons: [c1, { ...c2, predecessorAssessmentId: id(889), prerequisiteBefore: { assessmentCode: 'REVIEW_REQUIRED', basisCode: 'EVIDENCE_REVIEW_REQUIRED' } }, c3] }],
    ['another count', { ...good, comparisons: [c1, { ...c2, sourceCountAfter: 9 }, c3] }],
    ['another digest', { ...good, comparisons: [c1, c2, { ...c3, predecessorCaseManifestSha256: digest(9) }] }],
    ['another prerequisite basis', { ...good, comparisons: [c1, c2, { ...c3, prerequisiteBefore: { assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basisCode: 'UNSUPPORTED_EVIDENCE' } }] }],
  ]
  for (const [label, delta] of vectors) assert.equal(summary(input, delta)[0], 'CONFLICT', label)
  assert.equal(summary(input)[0], 'HISTORICAL_EVIDENCE_UNRECORDED')
})

test('a timeline that disagrees with itself is a provenance conflict', () => {
  const good = [entry(1, 'case'), entry(2, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'), entry(3)]
  const base = timeline(good)
  const delta = deltaOf(base)
  const unknownBasis = { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], basisCode: 'PAYER_DENIED' }] }
  const vectors: [string, TimelineFacts][] = [
    ['future A7.7 contract', timeline(good, { contractVersion: 'A7-REVENUE-TIMELINE-2' })],
    ['wrong chain code', timeline(good, { chainCode: 'NO_FROZEN_SUBMISSION' })],
    ['wrong history count', timeline(good, { historyCount: 2 })],
    ['ordinal gap', timeline([good[0], { ...good[1], ordinal: 3 }, good[2]])],
    ['mismatched predecessor', timeline([good[0], { ...good[1], priorSubmissionId: id(177) }, good[2]])],
    ['missing link', timeline([good[0], { ...good[1], correctionLinkId: null }, good[2]])],
    ['repeated freeze', timeline([good[0], { ...good[1], claimSubmissionId: id(101) }, good[2]])],
    ['wrong chronology', timeline([good[0], { ...good[1], frozenAt: at(0) }, good[2]])],
    ['two cases', timeline([{ ...good[0], caseSummaries: [caseOf(1), caseOf(1, { caseId: id(398) })] }, good[1], good[2]])],
    ['future case contract', timeline([{ ...good[0], caseSummaries: [caseOf(1, { contractVersion: 'A7-REVENUE-CASE-2' })] }, good[1], good[2]])],
    ['malformed digest', timeline([{ ...good[0], caseSummaries: [caseOf(1, { manifestSha256: 'ABC' })] }, good[1], good[2]])],
    ['two assessments', timeline([good[0], { ...good[1], prerequisiteSummaries: [good[1].prerequisiteSummaries[0], { ...good[1].prerequisiteSummaries[0], assessmentId: id(498) }] }, good[2]])],
    ['future assessment contract', timeline([good[0], { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], contractVersion: 'A7-CLOSURE-PREREQ-2' }] }, good[2]])],
    ['digest mismatch', timeline([good[0], { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], caseManifestSha256: digest(9) }] }, good[2]])],
    ['unknown controlled basis', timeline([good[0], unknownBasis, good[2]])],
    ['assessment without case', timeline([good[0], good[1], { ...good[2], prerequisiteSummaries: good[1].prerequisiteSummaries }])],
  ]
  for (const [label, input] of vectors) assert.equal(summary(input, delta)[0], 'CONFLICT', label)
})

test('time zone, locale and repetition never change the result', () => {
  const input = timeline([entry(1), entry(2, 'case'), entry(3, 'REVIEW_REQUIRED'), entry(4, 'NO_SOURCE_BASIS')])
  const delta = deltaOf(input)
  const results = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveRevenueContinuity(input, delta))))
  assert.equal(results.size, 1)
  const zone = process.env.TZ
  process.env.TZ = 'Pacific/Kiritimati'
  try {
    assert.equal(JSON.stringify(deriveRevenueContinuity(input, delta)), [...results][0])
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})
