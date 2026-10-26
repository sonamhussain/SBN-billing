import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveRevenueDelta } from './revenue-delta.reducer.ts'
import type { TimelineCaseFacts, TimelineEntryFacts, TimelineFacts } from './revenue-delta.types.ts'

// A7.8 — the pure delta reducer. Synthetic values only.

const CLAIM = '00000000-0000-4000-8000-0000000000c1'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const digest = (n: number) => String(n).padStart(64, 'a')
const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString()
const caseOf = (n: number, overrides: Partial<TimelineCaseFacts> = {}): TimelineCaseFacts => ({
  caseId: id(300 + n), contractVersion: 'A7-REVENUE-CASE-1', assemblyCode: 'INVENTORY_COMPLETE', sourceCount: 2, classifiedCount: 2, readinessCount: 2, itemCount: 2, manifestSha256: digest(n), ...overrides,
})
const assessed = (c: TimelineCaseFacts, n: number) => ({ assessmentId: id(400 + n), caseId: c.caseId, contractVersion: 'A7-CLOSURE-PREREQ-1', assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basisCode: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', caseManifestSha256: c.manifestSha256 })
// Entry n is freeze 1n frozen at second n, linked from freeze n-1 by link 2n.
const entry = (n: number, c: TimelineCaseFacts | null = null, withAssessment = false): TimelineEntryFacts => ({
  ordinal: n, claimSubmissionId: id(100 + n), priorSubmissionId: n === 1 ? null : id(99 + n), correctionLinkId: n === 1 ? null : id(200 + n), frozenAt: at(n),
  caseSummaries: c ? [c] : [], prerequisiteSummaries: c && withAssessment ? [assessed(c, n)] : [],
})
const timeline = (entries: TimelineEntryFacts[], overrides: Partial<TimelineFacts> = {}): TimelineFacts => ({
  contractVersion: 'A7-REVENUE-TIMELINE-1', claimId: CLAIM, chainCode: entries.length === 0 ? 'NO_FROZEN_SUBMISSION' : 'LINEAR_HISTORY', submissions: entries, historyCount: entries.length, ...overrides,
})
const codes = (input: TimelineFacts) => {
  const result = deriveRevenueDelta(input)
  return result.ok ? [result.value.baselineCode, ...result.value.comparisons.map((c) => c.evidenceDeltaCode)] : ['CONFLICT']
}

test('zero, one and many freezes give the baseline and max(0, N-1) comparisons', () => {
  assert.deepEqual(codes(timeline([])), ['NO_FROZEN_SUBMISSION'])
  assert.deepEqual(codes(timeline([entry(1)])), ['SINGLE_FREEZE'])
  assert.deepEqual(codes(timeline([entry(1), entry(2), entry(3), entry(4)])), ['COMPARABLE_HISTORY', 'BOTH_ABSENT', 'BOTH_ABSENT', 'BOTH_ABSENT'])
})

test('the worked example: no case, then a case, then another case is NEW_CASE_RECORDED then CHANGED', () => {
  const result = deriveRevenueDelta(timeline([entry(1), entry(2, caseOf(2), true), entry(3, caseOf(3, { sourceCount: 3, classifiedCount: 3, readinessCount: 3, itemCount: 3 }))]))
  assert.equal(result.ok, true)
  if (!result.ok) return
  const [first, second] = result.value.comparisons
  assert.deepEqual([first.ordinal, first.predecessorSubmissionId, first.correctedSubmissionId, first.correctionLinkId, first.evidenceDeltaCode], [1, id(101), id(102), id(202), 'NEW_CASE_RECORDED'])
  assert.deepEqual([first.predecessorCaseId, first.sourceCountBefore, first.prerequisiteBefore, first.predecessorCaseManifestSha256], [null, null, null, null])
  assert.deepEqual(first.prerequisiteAfter, { assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basisCode: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' })
  assert.deepEqual([second.evidenceDeltaCode, second.sourceCountBefore, second.sourceCountAfter, second.prerequisiteBefore?.assessmentCode, second.prerequisiteAfter], ['RECORDED_SUMMARY_CHANGED', 2, 3, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', null])
  assert.equal(Object.keys(first).length, 21)
})

test('absence on one side is NEW_CASE_RECORDED or CASE_NO_LONGER_RECORDED, never a zero', () => {
  assert.deepEqual(codes(timeline([entry(1, caseOf(1)), entry(2)])), ['COMPARABLE_HISTORY', 'CASE_NO_LONGER_RECORDED'])
  const result = deriveRevenueDelta(timeline([entry(1, caseOf(1)), entry(2)]))
  assert.equal(result.ok && result.value.comparisons[0].sourceCountAfter, null)
})

test('equal stored summaries are UNCHANGED; any single compared field changes the code', () => {
  const same = caseOf(1)
  assert.deepEqual(codes(timeline([entry(1, same), entry(2, { ...same, caseId: id(399) })])), ['COMPARABLE_HISTORY', 'RECORDED_SUMMARY_UNCHANGED'])
  for (const change of [{ manifestSha256: digest(9) }, { sourceCount: 3 }, { assemblyCode: 'INVENTORY_INCOMPLETE' }, { classifiedCount: 1 }, { readinessCount: 1 }, { itemCount: 3 }]) {
    assert.deepEqual(codes(timeline([entry(1, same), entry(2, { ...same, caseId: id(399), ...change })])), ['COMPARABLE_HISTORY', 'RECORDED_SUMMARY_CHANGED'], JSON.stringify(change))
  }
})

test('the assessment is shown on each side but never decides the code', () => {
  const same = caseOf(1)
  const twin = { ...same, caseId: id(399) }
  assert.deepEqual(codes(timeline([entry(1, same, true), entry(2, twin)])), ['COMPARABLE_HISTORY', 'RECORDED_SUMMARY_UNCHANGED'])
})

test('a timeline that disagrees with itself is a provenance conflict, never a partial delta', () => {
  const good = [entry(1, caseOf(1)), entry(2, caseOf(2), true), entry(3)]
  for (const [label, input] of [
    ['future A7.7 contract', timeline(good, { contractVersion: 'A7-REVENUE-TIMELINE-2' })],
    ['wrong chain code', timeline(good, { chainCode: 'NO_FROZEN_SUBMISSION' })],
    ['unknown chain code', timeline(good, { chainCode: 'FORKED' })],
    ['wrong history count', timeline(good, { historyCount: 2 })],
    ['noncontiguous ordinal', timeline([good[0], { ...good[1], ordinal: 3 }, good[2]])],
    ['mismatched predecessor', timeline([good[0], { ...good[1], priorSubmissionId: id(177) }, good[2]])],
    ['missing link', timeline([good[0], { ...good[1], correctionLinkId: null }, good[2]])],
    ['repeated link', timeline([good[0], good[1], { ...good[2], correctionLinkId: good[1].correctionLinkId }])],
    ['root with predecessor', timeline([{ ...good[0], priorSubmissionId: id(177) }, good[1], good[2]])],
    ['repeated freeze', timeline([good[0], { ...good[1], claimSubmissionId: id(101) }, good[2]])],
    ['wrong chronology', timeline([good[0], { ...good[1], frozenAt: at(0) }, good[2]])],
    ['equal instants', timeline([good[0], { ...good[1], frozenAt: good[0].frozenAt }, good[2]])],
    ['non-canonical instant', timeline([good[0], { ...good[1], frozenAt: '2026-10-01 00:00:02' }, good[2]])],
    ['two cases', timeline([{ ...good[0], caseSummaries: [caseOf(1), caseOf(7)] }, good[1], good[2]])],
    ['future A7.4 contract', timeline([{ ...good[0], caseSummaries: [caseOf(1, { contractVersion: 'A7-REVENUE-CASE-2' })] }, good[1], good[2]])],
    ['malformed digest', timeline([{ ...good[0], caseSummaries: [caseOf(1, { manifestSha256: 'ABC' })] }, good[1], good[2]])],
    ['uncontrolled assembly code', timeline([{ ...good[0], caseSummaries: [caseOf(1, { assemblyCode: 'INVENTORY_READY' })] }, good[1], good[2]])],
    ['negative count', timeline([{ ...good[0], caseSummaries: [caseOf(1, { sourceCount: -1 })] }, good[1], good[2]])],
    ['two assessments', timeline([good[0], { ...good[1], prerequisiteSummaries: [...good[1].prerequisiteSummaries, { ...good[1].prerequisiteSummaries[0], assessmentId: id(499) }] }, good[2]])],
    ['assessment without case', timeline([good[0], good[1], { ...good[2], prerequisiteSummaries: [assessed(caseOf(3), 3)] }])],
    ['assessment of another case', timeline([good[0], { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], caseId: id(377) }] }, good[2]])],
    ['future A7.5 contract', timeline([good[0], { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], contractVersion: 'A7-CLOSURE-PREREQ-2' }] }, good[2]])],
    ['digest/assessment mismatch', timeline([good[0], { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], caseManifestSha256: digest(9) }] }, good[2]])],
    ['uncontrolled pair', timeline([good[0], { ...good[1], prerequisiteSummaries: [{ ...good[1].prerequisiteSummaries[0], basisCode: 'NO_REGISTERED_SOURCES' }] }, good[2]])],
  ] as const) {
    assert.deepEqual(codes(input), ['CONFLICT'], label)
  }
})

test('one hundred reductions of the same timeline are identical', () => {
  const input = timeline([entry(1), entry(2, caseOf(2), true), entry(3, caseOf(3))])
  assert.equal(new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveRevenueDelta(input)))).size, 1)
})
