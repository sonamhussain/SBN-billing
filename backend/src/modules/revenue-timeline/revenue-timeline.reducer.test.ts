import test from 'node:test'
import assert from 'node:assert/strict'
import { composeTimeline } from './revenue-timeline.reducer.ts'
import type { AssessmentFacts, CaseFacts, FreezeFacts, LinkFacts, TimelineFacts } from './revenue-timeline.types.ts'

// A7.7 — the pure timeline composer. Synthetic values only.

const CLAIM = '00000000-0000-4000-8000-0000000000c1'
const ORG = '00000000-0000-4000-8000-0000000000a1'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const digest = (n: number) => String(n).padStart(64, 'a')
// Freeze n is frozen at n seconds; link n corrects freeze n with freeze n+1.
const freeze = (n: number, micros = n * 1_000_000): FreezeFacts => ({ submissionId: id(100 + n), claimId: CLAIM, frozenAt: new Date(micros / 1000).toISOString(), frozenAtMicros: micros })
const link = (n: number, prior = n, corrected = n + 1): LinkFacts => ({ correctionLinkId: id(200 + n), claimId: CLAIM, priorSubmissionId: id(100 + prior), correctedSubmissionId: id(100 + corrected) })
const caseOf = (n: number, overrides: Partial<CaseFacts> = {}): CaseFacts => ({
  caseId: id(300 + n), claimSubmissionId: id(100 + n), organizationId: ORG, contractVersion: 'A7-REVENUE-CASE-1', assemblyCode: 'INVENTORY_COMPLETE',
  sourceCount: 2, classifiedCount: 2, readinessCount: 2, itemCount: 2, manifestSha256: digest(n), ...overrides,
})
const assessmentOf = (n: number, overrides: Partial<AssessmentFacts> = {}): AssessmentFacts => ({
  assessmentId: id(400 + n), caseId: id(300 + n), organizationId: ORG, contractVersion: 'A7-CLOSURE-PREREQ-1', assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basisCode: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', caseManifestSha256: digest(n), ...overrides,
})
const facts = (overrides: Partial<TimelineFacts>): TimelineFacts => ({ claimId: CLAIM, organizationId: ORG, freezes: [], links: [], cases: [], assessments: [], ...overrides })
const isConflict = (input: TimelineFacts) => {
  const result = composeTimeline(input)
  return !result.ok && result.refusal === 'PROVENANCE_CONFLICT'
}

test('a claim with no freeze is an explicit empty history', () => {
  assert.deepEqual(composeTimeline(facts({})), { ok: true, value: { chainCode: 'NO_FROZEN_SUBMISSION', submissions: [] } })
})

test('one freeze is a one-node root with no predecessor and no link', () => {
  const result = composeTimeline(facts({ freezes: [freeze(1)] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.chainCode, 'LINEAR_HISTORY')
  assert.deepEqual(result.value.submissions, [{ ordinal: 1, claimSubmissionId: id(101), priorSubmissionId: null, correctionLinkId: null, frozenAt: freeze(1).frozenAt, caseSummaries: [], prerequisiteSummaries: [] }])
})

test('the worked scenario: S1 with CASE1 and ASSESS1, S2 with CASE2 unassessed, L12 only on S2', () => {
  const result = composeTimeline(facts({ freezes: [freeze(2), freeze(1)], links: [link(1)], cases: [caseOf(2), caseOf(1)], assessments: [assessmentOf(1)] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  const [s1, s2] = result.value.submissions
  assert.deepEqual([s1.ordinal, s1.claimSubmissionId, s1.priorSubmissionId, s1.correctionLinkId], [1, id(101), null, null])
  assert.deepEqual([s2.ordinal, s2.claimSubmissionId, s2.priorSubmissionId, s2.correctionLinkId], [2, id(102), id(101), id(201)])
  assert.deepEqual(s1.caseSummaries.map((c) => c.caseId), [id(301)])
  assert.deepEqual(s1.prerequisiteSummaries.map((a) => [a.assessmentId, a.caseId, a.assessmentCode, a.basisCode]), [[id(401), id(301), 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED']])
  assert.deepEqual([s2.caseSummaries.map((c) => c.caseId), s2.prerequisiteSummaries], [[id(302)], []])
  assert.deepEqual(Object.keys(s1.caseSummaries[0]), ['caseId', 'contractVersion', 'assemblyCode', 'sourceCount', 'classifiedCount', 'readinessCount', 'itemCount', 'manifestSha256'])
})

test('four linked freezes give contiguous ordinals in edge order, whatever order the freezes arrive in', () => {
  const result = composeTimeline(facts({ freezes: [freeze(3), freeze(1), freeze(4), freeze(2)], links: [link(1), link(2), link(3)] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.submissions.map((s) => [s.ordinal, s.claimSubmissionId]), [[1, id(101)], [2, id(102)], [3, id(103)], [4, id(104)]])
})

test('every illegal graph is a provenance conflict, never a guessed order', () => {
  const four = [freeze(1), freeze(2), freeze(3), freeze(4)]
  for (const [label, input] of [
    ['unlinked extra freeze', facts({ freezes: [freeze(1), freeze(2), freeze(3)], links: [link(1)] })],
    ['two unrelated roots', facts({ freezes: four, links: [link(1), link(3)] })],
    ['fork', facts({ freezes: [freeze(1), freeze(2), freeze(3)], links: [link(1), link(9, 1, 3)] })],
    ['join', facts({ freezes: [freeze(1), freeze(2), freeze(3)], links: [link(1, 1, 3), link(2, 2, 3)] })],
    ['two-node cycle', facts({ freezes: [freeze(1), freeze(2)], links: [link(1), link(2, 2, 1)] })],
    ['longer cycle', facts({ freezes: [freeze(1), freeze(2), freeze(3)], links: [link(1), link(2), link(3, 3, 1)] })],
    ['root plus a separate cycle', facts({ freezes: four, links: [link(2), link(3, 3, 2)] })],
    ['self-link', facts({ freezes: [freeze(1), freeze(2)], links: [link(1), link(2, 2, 2)] })],
    ['cross-claim link', facts({ freezes: [freeze(1), freeze(2)], links: [{ ...link(1), claimId: id(999) }] })],
    ['link to a foreign freeze', facts({ freezes: [freeze(1), freeze(2)], links: [link(1, 1, 7)] })],
    ['foreign freeze in the list', facts({ freezes: [freeze(1), { ...freeze(2), claimId: id(999) }], links: [link(1)] })],
    ['repeated freeze', facts({ freezes: [freeze(1), freeze(1)] })],
    ['equal freeze instant, no tie-break', facts({ freezes: [freeze(1, 5), freeze(2, 5)], links: [link(1)] })],
    ['correction frozen before its prior', facts({ freezes: [freeze(1, 9), freeze(2, 5)], links: [link(1)] })],
    ['unknown freeze instant', facts({ freezes: [freeze(1), { ...freeze(2), frozenAtMicros: Number.NaN }], links: [link(1)] })],
    ['A6.9 order disagrees with the edges', facts({ freezes: [freeze(1), freeze(2), freeze(3)], links: [link(2), link(1)] })],
    ['history for a claim with no freeze', facts({ links: [link(1)] })],
  ] as const) {
    assert.equal(isConflict(input), true, label)
  }
})

test('a foreign, misplaced, duplicate or unsupported case is refused, never the newest chosen', () => {
  const base = { freezes: [freeze(1), freeze(2)], links: [link(1)] }
  for (const [label, cases] of [
    ['case of another freeze', [caseOf(1, { claimSubmissionId: id(177) })]],
    ['case of another organization', [caseOf(1, { organizationId: id(999) })]],
    ['unsupported case contract', [caseOf(1, { contractVersion: 'A7-REVENUE-CASE-2' })]],
    ['second v1 case for one freeze', [caseOf(1), caseOf(1, { caseId: id(399) })]],
    ['uncontrolled assembly code', [caseOf(1, { assemblyCode: 'INVENTORY_READY' })]],
    ['negative count', [caseOf(1, { itemCount: -1 })]],
    ['malformed digest', [caseOf(1, { manifestSha256: 'ABC' })]],
  ] as const) {
    assert.equal(isConflict(facts({ ...base, cases: [...cases] })), true, label)
  }
})

test('a foreign, mismatched, duplicate, future or uncontrolled assessment is refused', () => {
  const base = { freezes: [freeze(1)], cases: [caseOf(1)] }
  for (const [label, assessments] of [
    ['assessment of an unknown case', [assessmentOf(1, { caseId: id(377) })]],
    ['assessment of another organization', [assessmentOf(1, { organizationId: id(999) })]],
    ['future assessment contract', [assessmentOf(1, { contractVersion: 'A7-CLOSURE-PREREQ-2' })]],
    ['second v1 assessment for one case', [assessmentOf(1), assessmentOf(1, { assessmentId: id(499) })]],
    ['digest of another case', [assessmentOf(1, { caseManifestSha256: digest(9) })]],
    ['uncontrolled code', [assessmentOf(1, { assessmentCode: 'PAID', basisCode: 'PAID' })]],
    ['code with another basis', [assessmentOf(1, { basisCode: 'NO_REGISTERED_SOURCES' })]],
  ] as const) {
    assert.equal(isConflict(facts({ ...base, assessments: [...assessments] })), true, label)
  }
})

test('absence is data: no case and an unassessed case are explicit empty lists', () => {
  const result = composeTimeline(facts({ freezes: [freeze(1), freeze(2)], links: [link(1)], cases: [caseOf(2)] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.submissions.map((s) => [s.caseSummaries.length, s.prerequisiteSummaries.length]), [[0, 0], [1, 0]])
})

test('fifty compositions of the same facts are identical, whatever the input order', () => {
  const input = facts({ freezes: [freeze(3), freeze(1), freeze(2)], links: [link(1), link(2)], cases: [caseOf(3), caseOf(1)], assessments: [assessmentOf(3), assessmentOf(1)] })
  const results = new Set(Array.from({ length: 50 }, () => JSON.stringify(composeTimeline(input))))
  assert.equal(results.size, 1)
  assert.equal(JSON.stringify(composeTimeline({ ...input, cases: [...input.cases].reverse(), assessments: [...input.assessments].reverse() })), [...results][0])
})
