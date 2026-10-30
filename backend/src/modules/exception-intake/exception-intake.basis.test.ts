import test from 'node:test'
import assert from 'node:assert/strict'
import { establishedBasis } from './exception-intake.basis.ts'
import type { AssessmentVerdict, TimelineVerdict } from './exception-intake.types.ts'

// A8.1 — the specific owner-backed basis of each reason, and fail-closed for everything else. Synthetic values only.

const F1 = '00000000-0000-4000-8000-0000000000f1'
const F2 = '00000000-0000-4000-8000-0000000000f2'
const F3 = '00000000-0000-4000-8000-0000000000f3'
const ORG = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2'
const CASE = '00000000-0000-4000-8000-0000000000e1'
const ASSESSMENT = '00000000-0000-4000-8000-0000000000b1'
const DIGEST = 'a'.repeat(64)

const timeline = (change: Partial<TimelineVerdict> = {}): TimelineVerdict => ({
  kind: 'REVENUE_TIMELINE',
  timelineCode: 'REVENUE_TIMELINE_PROVENANCE_CONFLICT',
  freezes: [
    { submissionId: F1, frozenAtMicros: 1_000 },
    { submissionId: F2, frozenAtMicros: 2_000 },
  ],
  links: [],
  ...change,
})
const assessment = (change: Partial<AssessmentVerdict> = {}): AssessmentVerdict => ({
  kind: 'CLOSURE_PREREQUISITE_ASSESSMENT',
  traceCode: 'CLOSURE_BASIS_PROVENANCE_CONFLICT',
  assessmentId: ASSESSMENT,
  assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT',
  assessmentOrganizationId: ORG,
  assessmentCaseDigest: DIGEST,
  caseId: CASE,
  caseOrganizationId: ORG,
  caseManifestSha256: 'b'.repeat(64),
  ...change,
})

test('an unlinked freeze beside a valid A6.9 chain proves PROVENANCE_CONFLICT; the basis is the latest unlinked freeze', () => {
  assert.deepEqual(establishedBasis(timeline(), 'PROVENANCE_CONFLICT'), { basisCode: 'UNLINKED_FROZEN_SUBMISSION', basisRecordId: F2 })
  const chained = timeline({ freezes: [...timeline().freezes, { submissionId: F3, frozenAtMicros: 3_000 }], links: [{ id: 'L1', priorSubmissionId: F1, correctedSubmissionId: F3 }] })
  assert.deepEqual(establishedBasis(chained, 'PROVENANCE_CONFLICT'), { basisCode: 'UNLINKED_FROZEN_SUBMISSION', basisRecordId: F2 })
})

test('a timeline refusal without the specific condition establishes nothing (fail closed)', () => {
  // the owner did not refuse, or refused for another code
  assert.equal(establishedBasis(timeline({ timelineCode: 'OK' }), 'PROVENANCE_CONFLICT'), null)
  assert.equal(establishedBasis(timeline({ timelineCode: 'NOT_FOUND' }), 'PROVENANCE_CONFLICT'), null)
  // one freeze, or every freeze chained: the refusal has another cause
  assert.equal(establishedBasis(timeline({ freezes: [{ submissionId: F1, frozenAtMicros: 1_000 }] }), 'PROVENANCE_CONFLICT'), null)
  assert.equal(establishedBasis(timeline({ links: [{ id: 'L1', priorSubmissionId: F1, correctedSubmissionId: F2 }] }), 'PROVENANCE_CONFLICT'), null)
  // a fork, a self link or a link naming a freeze of another Claim: the A6.9 chain logic refuses, nothing is proved
  const three = [...timeline().freezes, { submissionId: F3, frozenAtMicros: 3_000 }]
  assert.equal(establishedBasis(timeline({ freezes: three, links: [{ id: 'L1', priorSubmissionId: F1, correctedSubmissionId: F2 }, { id: 'L2', priorSubmissionId: F1, correctedSubmissionId: F3 }] }), 'PROVENANCE_CONFLICT'), null)
  assert.equal(establishedBasis(timeline({ freezes: three, links: [{ id: 'L1', priorSubmissionId: F3, correctedSubmissionId: F3 }] }), 'PROVENANCE_CONFLICT'), null)
  assert.equal(establishedBasis(timeline({ links: [{ id: 'L1', priorSubmissionId: F1, correctedSubmissionId: F3 }] }), 'PROVENANCE_CONFLICT'), null)
  // two unlinked freezes at one instant: the latest is ambiguous, never broken by identifier
  assert.equal(establishedBasis(timeline({ freezes: [{ submissionId: F1, frozenAtMicros: 2_000 }, { submissionId: F2, frozenAtMicros: 2_000 }] }), 'PROVENANCE_CONFLICT'), null)
  // a repeated freeze or an unknown instant
  assert.equal(establishedBasis(timeline({ freezes: [{ submissionId: F1, frozenAtMicros: 1_000 }, { submissionId: F1, frozenAtMicros: 2_000 }] }), 'PROVENANCE_CONFLICT'), null)
  assert.equal(establishedBasis(timeline({ freezes: [{ submissionId: F1, frozenAtMicros: 1_000 }, { submissionId: F2, frozenAtMicros: Number.NaN }] }), 'PROVENANCE_CONFLICT'), null)
})

test('an assessment that disagrees with its case proves HISTORICAL_RECORD_INCONSISTENT, organization first', () => {
  assert.deepEqual(establishedBasis(assessment(), 'HISTORICAL_RECORD_INCONSISTENT'), { basisCode: 'ASSESSMENT_CASE_DIGEST_MISMATCH', basisRecordId: CASE })
  assert.deepEqual(establishedBasis(assessment({ caseOrganizationId: OTHER_ORG }), 'HISTORICAL_RECORD_INCONSISTENT'), { basisCode: 'ASSESSMENT_CASE_ORGANIZATION_MISMATCH', basisRecordId: CASE })
})

test('a trace refusal without a stored assessment/case disagreement establishes nothing (fail closed)', () => {
  assert.equal(establishedBasis(assessment({ caseManifestSha256: DIGEST }), 'HISTORICAL_RECORD_INCONSISTENT'), null)
  assert.equal(establishedBasis(assessment({ traceCode: 'OK' }), 'HISTORICAL_RECORD_INCONSISTENT'), null)
  assert.equal(establishedBasis(assessment({ traceCode: 'NOT_FOUND' }), 'HISTORICAL_RECORD_INCONSISTENT'), null)
  assert.equal(establishedBasis(assessment({ caseOrganizationId: null }), 'HISTORICAL_RECORD_INCONSISTENT'), null)
  assert.equal(establishedBasis(assessment({ caseManifestSha256: null }), 'HISTORICAL_RECORD_INCONSISTENT'), null)
})

test('only the exact recorded REVIEW_REQUIRED assessment proves OPERATOR_REVIEW_REQUIRED', () => {
  assert.deepEqual(establishedBasis(assessment({ traceCode: 'OK', assessmentCode: 'REVIEW_REQUIRED' }), 'OPERATOR_REVIEW_REQUIRED'), { basisCode: 'ASSESSMENT_REVIEW_REQUIRED', basisRecordId: ASSESSMENT })
  for (const assessmentCode of ['EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'NO_SOURCE_BASIS', 'INCOMPLETE_SOURCE_CHAIN', 'UNSUPPORTED_SOURCE_BASIS', 'review_required', 'PAID', '']) {
    assert.equal(establishedBasis(assessment({ traceCode: 'OK', assessmentCode }), 'OPERATOR_REVIEW_REQUIRED'), null, assessmentCode)
  }
})

test('a reason outside its source kind, and the disabled reasons, are never established', () => {
  assert.equal(establishedBasis(timeline(), 'HISTORICAL_RECORD_INCONSISTENT'), null)
  assert.equal(establishedBasis(timeline(), 'OPERATOR_REVIEW_REQUIRED'), null)
  assert.equal(establishedBasis(assessment(), 'PROVENANCE_CONFLICT'), null)
  for (const reason of ['SOURCE_REFERENCE_UNAVAILABLE', 'CONTRACT_VERSION_UNSUPPORTED'] as const) {
    assert.equal(establishedBasis(timeline(), reason), null, reason)
    assert.equal(establishedBasis(assessment({ assessmentCode: 'REVIEW_REQUIRED' }), reason), null, reason)
  }
})
