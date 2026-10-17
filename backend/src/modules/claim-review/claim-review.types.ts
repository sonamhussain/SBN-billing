// A6.5 — a human review decision answers one question: has a named, authenticated and authorized person
// decided about ONE exact A6.4 draft assessment of a Claim? APPROVE is a human authorization record that a
// later freeze gate (A6.7) may consume; it is never submission, payload or transport. RETURN and REJECT
// grant nothing; REVOKE withdraws the approval that is the Claim's latest decision.
//
// Current approval authority is never stored. It is derived from the Claim's latest decision by its
// Claim-local sequence and a fresh A6.4 currentness check on the same snapshot, so an approval whose
// reviewed draft has changed stops granting anything without any row being rewritten.

export const REVIEW_CONTRACT_VERSION = 'A6-REVIEW-1'

export const reviewDecisionCodes = ['APPROVE', 'RETURN', 'REJECT', 'REVOKE'] as const
export type ReviewDecisionCode = (typeof reviewDecisionCodes)[number]

// §3 — the controlled reason vocabulary. A reason is a code, never a free-text remark.
export const reviewReasonCodes = ['REVIEW_DOCUMENTATION_REQUIRED', 'REVIEW_CODING_CORRECTION', 'REVIEW_PRICING_QUESTION', 'REVIEW_INTEGRITY_CONCERN', 'REVIEW_OTHER'] as const
export type ReviewReasonCode = (typeof reviewReasonCodes)[number]

// §6 — the derived authority. Only APPROVED_CURRENT grants anything; APPROVAL_STALE names the approval that
// no longer matches its reviewed draft and grants nothing.
export const reviewAuthorityStates = ['APPROVED_CURRENT', 'NOT_APPROVED', 'APPROVAL_STALE'] as const
export type ReviewAuthorityState = (typeof reviewAuthorityStates)[number]

// §5 — the validated request. Claim, reviewer, sequence and every instant are the server's.
export type ReviewDecisionRequest = {
  draftAssessmentId: string
  assemblyFingerprint: string
  decisionCode: ReviewDecisionCode
  reasonCode: ReviewReasonCode | null
  referencedApprovalId: string | null
}

// §8 — identifiers, codes, the Claim-local sequence and UTC instants only: no patient, diagnosis, code
// text, amount or remark.
export type ReviewDecisionDto = {
  id: string
  claimId: string
  draftAssessmentId: string
  reviewerUserId: string
  decisionCode: ReviewDecisionCode
  sequence: number
  approvalFingerprint: string | null
  reasonCode: ReviewReasonCode | null
  referencedApprovalId: string | null
  reviewContractVersion: string
  reviewedAt: string
  createdAt: string
}

export type ReviewDecisionListDto = { items: ReviewDecisionDto[] }

export type ReviewAuthorityDto = {
  claimId: string
  state: ReviewAuthorityState
  // The latest decision by sequence (null when the Claim has none), the assessment it is about and, for an
  // approval, its reviewed fingerprint.
  decisionId: string | null
  draftAssessmentId: string | null
  fingerprint: string | null
  evaluatedAt: string
}

export type RecordedReviewDecisionDto = { decision: ReviewDecisionDto; authority: ReviewAuthorityDto }

// §9 — refusals.
export type ClaimReviewErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CLAIM_REVIEW_NOT_REVIEWABLE'
  | 'CLAIM_REVIEW_STALE'
  | 'CLAIM_REVIEW_SEPARATION_REQUIRED'
  | 'CLAIM_REVIEW_CONFLICT'
  | 'INTEGRITY_CONFLICT'

export type ClaimReviewResult<T> = { ok: true; value: T } | { ok: false; code: ClaimReviewErrorCode; message: string }
