import test from 'node:test'
import assert from 'node:assert/strict'
import { admitDecision, auditActionOf, deriveAuthority, nextSequence, type AdmissionFacts, type LatestDecision } from './claim-review.policy.ts'
import { REVIEW_CONTRACT_VERSION, reviewDecisionCodes, reviewReasonCodes, type ReviewDecisionRequest } from './claim-review.types.ts'
import { validateReviewDecisionBody } from './claim-review.validation.ts'

// A6.5 — pure review decision rules and the strict request. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FP = 'a'.repeat(64)
const OTHER_FP = 'b'.repeat(64)
const ASSESSMENT = id(1)
const OTHER_ASSESSMENT = id(2)
const CREATOR = id(10)
const ASSESSOR = id(11)
const REVIEWER = id(12)
const APPROVAL = id(20)

const approve = (overrides: Partial<NonNullable<LatestDecision>> = {}): NonNullable<LatestDecision> => ({ id: APPROVAL, decisionCode: 'APPROVE', draftAssessmentId: ASSESSMENT, approvalFingerprint: FP, sequence: 1, ...overrides })
const request = (overrides: Partial<ReviewDecisionRequest> = {}): ReviewDecisionRequest => ({ draftAssessmentId: ASSESSMENT, assemblyFingerprint: FP, decisionCode: 'APPROVE', reasonCode: null, referencedApprovalId: null, ...overrides })
const facts = (overrides: Partial<AdmissionFacts> = {}): AdmissionFacts => ({
  request: request(),
  reviewerUserId: REVIEWER,
  claimCreatorUserId: CREATOR,
  assessment: { outcome: 'REVIEWABLE', assemblyFingerprint: FP, createdByUserId: ASSESSOR },
  latest: null,
  authority: 'NOT_APPROVED',
  requestedCurrentness: { outcome: 'REVIEWABLE', assemblyFingerprint: FP },
  ...overrides,
})
const codeOf = (admission: ReturnType<typeof admitDecision>) => (admission.ok ? 'OK' : admission.code)

test('the contract and vocabularies are fixed', () => {
  assert.equal(REVIEW_CONTRACT_VERSION, 'A6-REVIEW-1')
  assert.deepEqual([...reviewDecisionCodes], ['APPROVE', 'RETURN', 'REJECT', 'REVOKE'])
  assert.deepEqual([...reviewReasonCodes], ['REVIEW_DOCUMENTATION_REQUIRED', 'REVIEW_CODING_CORRECTION', 'REVIEW_PRICING_QUESTION', 'REVIEW_INTEGRITY_CONCERN', 'REVIEW_OTHER'])
})

test('authority: no decision, a non-approval or a revocation grants nothing', () => {
  assert.deepEqual(deriveAuthority(null, null), { state: 'NOT_APPROVED', decisionId: null, draftAssessmentId: null, fingerprint: null })
  for (const decisionCode of ['RETURN', 'REJECT', 'REVOKE'])
    assert.deepEqual(deriveAuthority({ ...approve(), decisionCode, approvalFingerprint: null }, { outcome: 'REVIEWABLE', assemblyFingerprint: FP }), {
      state: 'NOT_APPROVED',
      decisionId: APPROVAL,
      draftAssessmentId: ASSESSMENT,
      fingerprint: null,
    })
})

test('authority: an approval is current only while its draft is REVIEWABLE with exactly the approved fingerprint', () => {
  assert.equal(deriveAuthority(approve(), { outcome: 'REVIEWABLE', assemblyFingerprint: FP }).state, 'APPROVED_CURRENT')
  assert.equal(deriveAuthority(approve(), { outcome: 'REVIEWABLE', assemblyFingerprint: OTHER_FP }).state, 'APPROVAL_STALE')
  for (const outcome of ['INCOMPLETE', 'STALE', 'INVALID']) assert.equal(deriveAuthority(approve(), { outcome, assemblyFingerprint: FP }).state, 'APPROVAL_STALE')
  assert.equal(deriveAuthority(approve(), null).state, 'APPROVAL_STALE')
  assert.equal(deriveAuthority(approve({ approvalFingerprint: null }), { outcome: 'REVIEWABLE', assemblyFingerprint: FP }).state, 'APPROVAL_STALE')
  assert.equal(deriveAuthority(approve(), { outcome: 'INVALID', assemblyFingerprint: FP }).fingerprint, FP)
})

test('approve: exact REVIEWABLE, current, separate reviewer and no current approval', () => {
  assert.equal(codeOf(admitDecision(facts())), 'OK')
  assert.equal(codeOf(admitDecision(facts({ request: request({ assemblyFingerprint: OTHER_FP }) }))), 'CLAIM_REVIEW_STALE')
  for (const outcome of ['INCOMPLETE', 'STALE', 'INVALID'])
    assert.equal(codeOf(admitDecision(facts({ assessment: { outcome, assemblyFingerprint: FP, createdByUserId: ASSESSOR } }))), 'CLAIM_REVIEW_NOT_REVIEWABLE')
  assert.equal(codeOf(admitDecision(facts({ reviewerUserId: CREATOR }))), 'CLAIM_REVIEW_SEPARATION_REQUIRED')
  assert.equal(codeOf(admitDecision(facts({ reviewerUserId: ASSESSOR }))), 'CLAIM_REVIEW_SEPARATION_REQUIRED')
  // One authorized user who created everything is refused; no approver is substituted.
  assert.equal(codeOf(admitDecision(facts({ reviewerUserId: CREATOR, claimCreatorUserId: CREATOR, assessment: { outcome: 'REVIEWABLE', assemblyFingerprint: FP, createdByUserId: CREATOR } }))), 'CLAIM_REVIEW_SEPARATION_REQUIRED')
  assert.equal(codeOf(admitDecision(facts({ latest: approve(), authority: 'APPROVED_CURRENT' }))), 'CLAIM_REVIEW_CONFLICT')
  assert.equal(codeOf(admitDecision(facts({ requestedCurrentness: { outcome: 'REVIEWABLE', assemblyFingerprint: OTHER_FP } }))), 'CLAIM_REVIEW_STALE')
  assert.equal(codeOf(admitDecision(facts({ requestedCurrentness: { outcome: 'STALE', assemblyFingerprint: FP } }))), 'CLAIM_REVIEW_STALE')
  assert.equal(codeOf(admitDecision(facts({ requestedCurrentness: null }))), 'CLAIM_REVIEW_STALE')
})

test('approve: a stale approval is superseded by a fresh valid approval; a current one first needs a revocation', () => {
  assert.equal(codeOf(admitDecision(facts({ latest: approve({ approvalFingerprint: OTHER_FP }), authority: 'APPROVAL_STALE' }))), 'OK')
  assert.equal(codeOf(admitDecision(facts({ latest: { ...approve(), decisionCode: 'REVOKE', approvalFingerprint: null }, authority: 'NOT_APPROVED' }))), 'OK')
})

test('return and reject: any own assessment, never over a current approval', () => {
  for (const decisionCode of ['RETURN', 'REJECT'] as const) {
    const decision = request({ decisionCode, reasonCode: 'REVIEW_CODING_CORRECTION' })
    assert.equal(codeOf(admitDecision(facts({ request: decision, assessment: { outcome: 'INVALID', assemblyFingerprint: FP, createdByUserId: ASSESSOR }, reviewerUserId: CREATOR }))), 'OK')
    assert.equal(codeOf(admitDecision(facts({ request: decision, latest: approve(), authority: 'APPROVED_CURRENT' }))), 'CLAIM_REVIEW_CONFLICT')
    assert.equal(codeOf(admitDecision(facts({ request: decision, latest: approve(), authority: 'APPROVAL_STALE' }))), 'OK')
    assert.equal(codeOf(admitDecision(facts({ request: { ...decision, assemblyFingerprint: OTHER_FP } }))), 'CLAIM_REVIEW_STALE')
  }
})

test('revoke: only the latest decision, which must be an APPROVE of the same assessment', () => {
  const revoke = request({ decisionCode: 'REVOKE', referencedApprovalId: APPROVAL })
  assert.equal(codeOf(admitDecision(facts({ request: revoke, latest: approve(), authority: 'APPROVED_CURRENT' }))), 'OK')
  assert.equal(codeOf(admitDecision(facts({ request: revoke, latest: approve(), authority: 'APPROVAL_STALE' }))), 'OK')
  assert.equal(codeOf(admitDecision(facts({ request: revoke, latest: null }))), 'CLAIM_REVIEW_CONFLICT')
  assert.equal(codeOf(admitDecision(facts({ request: revoke, latest: { ...approve(), decisionCode: 'REVOKE', id: id(21) } }))), 'CLAIM_REVIEW_CONFLICT')
  assert.equal(codeOf(admitDecision(facts({ request: revoke, latest: approve({ id: id(22) }) }))), 'CLAIM_REVIEW_CONFLICT')
  assert.equal(codeOf(admitDecision(facts({ request: revoke, latest: approve({ draftAssessmentId: OTHER_ASSESSMENT }) }))), 'CLAIM_REVIEW_CONFLICT')
})

test('sequence and audit action', () => {
  assert.equal(nextSequence(null), 1)
  assert.equal(nextSequence(approve({ sequence: 7 })), 8)
  assert.deepEqual(
    reviewDecisionCodes.map((code) => auditActionOf(code)),
    ['claim_review.approved', 'claim_review.returned', 'claim_review.rejected', 'claim_review.revoked'],
  )
})

test('request: strict shapes per decision', () => {
  const base = { draftAssessmentId: ASSESSMENT, assemblyFingerprint: FP }
  assert.deepEqual(validateReviewDecisionBody({ ...base, decisionCode: 'APPROVE' }), { ok: true, value: request() })
  assert.deepEqual(validateReviewDecisionBody({ ...base, decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' }), { ok: true, value: request({ decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' }) })
  assert.deepEqual(validateReviewDecisionBody({ ...base, decisionCode: 'REVOKE', referencedApprovalId: APPROVAL }), { ok: true, value: request({ decisionCode: 'REVOKE', referencedApprovalId: APPROVAL }) })
  assert.deepEqual(validateReviewDecisionBody({ ...base, decisionCode: 'REVOKE', referencedApprovalId: APPROVAL, reasonCode: 'REVIEW_INTEGRITY_CONCERN' }), {
    ok: true,
    value: request({ decisionCode: 'REVOKE', referencedApprovalId: APPROVAL, reasonCode: 'REVIEW_INTEGRITY_CONCERN' }),
  })
  const refused = [
    null,
    [],
    'APPROVE',
    { ...base },
    { ...base, decisionCode: 'approve' },
    { ...base, decisionCode: 'SUBMIT' },
    { ...base, decisionCode: 'APPROVE', reasonCode: 'REVIEW_OTHER' },
    { ...base, decisionCode: 'APPROVE', referencedApprovalId: APPROVAL },
    { ...base, decisionCode: 'RETURN' },
    { ...base, decisionCode: 'REJECT', reasonCode: 'patient looked unwell' },
    { ...base, decisionCode: 'REJECT', reasonCode: 'REVIEW_OTHER', referencedApprovalId: APPROVAL },
    { ...base, decisionCode: 'REVOKE' },
    { ...base, decisionCode: 'REVOKE', referencedApprovalId: 'not-a-uuid' },
    { ...base, decisionCode: 'APPROVE', draftAssessmentId: 'not-a-uuid' },
    { ...base, decisionCode: 'APPROVE', assemblyFingerprint: FP.toUpperCase() },
    { ...base, decisionCode: 'APPROVE', assemblyFingerprint: FP.slice(1) },
    { ...base, decisionCode: 'APPROVE', remark: 'looks fine' },
  ]
  for (const body of refused) assert.equal(validateReviewDecisionBody(body).ok, false, JSON.stringify(body))
  for (const forged of ['claimId', 'reviewerUserId', 'actorUserId', 'sequence', 'approvalFingerprint', 'reviewedAt', 'createdAt', 'reviewContractVersion', 'total', 'payload']) {
    const outcome = validateReviewDecisionBody({ ...base, decisionCode: 'APPROVE', [forged]: 'x' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.ok ? '' : outcome.message, new RegExp(`${forged} is owned by the server`))
  }
})
