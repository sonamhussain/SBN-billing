import type { ClaimReviewErrorCode, ReviewAuthorityState, ReviewDecisionCode, ReviewDecisionRequest } from './claim-review.types.ts'

// A6.5 — the pure decision rules: how current authority is derived from the latest decision, and which
// requested decision may be appended. The service supplies facts read on one locked snapshot; nothing here
// reads, writes or decides by time.

export type LatestDecision = {
  id: string
  decisionCode: string
  draftAssessmentId: string
  approvalFingerprint: string | null
  sequence: number
} | null

// What the A6.4 owner composes for an assessment's exact pricing run on the same snapshot; null when it
// could not be composed at all.
export type Currentness = { outcome: string; assemblyFingerprint: string } | null

export type DerivedAuthority = { state: ReviewAuthorityState; decisionId: string | null; draftAssessmentId: string | null; fingerprint: string | null }

// §6 — the latest decision by sequence decides. Anything but an APPROVE grants nothing. An APPROVE grants
// authority only while the A6.4 owner still composes its reviewed draft as REVIEWABLE with exactly the
// approved fingerprint; otherwise it is APPROVAL_STALE and grants nothing.
export function deriveAuthority(latest: LatestDecision, currentness: Currentness): DerivedAuthority {
  if (latest === null) return { state: 'NOT_APPROVED', decisionId: null, draftAssessmentId: null, fingerprint: null }
  if (latest.decisionCode !== 'APPROVE') return { state: 'NOT_APPROVED', decisionId: latest.id, draftAssessmentId: latest.draftAssessmentId, fingerprint: null }
  const current = currentness !== null && currentness.outcome === 'REVIEWABLE' && latest.approvalFingerprint !== null && currentness.assemblyFingerprint === latest.approvalFingerprint
  return { state: current ? 'APPROVED_CURRENT' : 'APPROVAL_STALE', decisionId: latest.id, draftAssessmentId: latest.draftAssessmentId, fingerprint: latest.approvalFingerprint }
}

export type AdmissionFacts = {
  request: ReviewDecisionRequest
  reviewerUserId: string
  claimCreatorUserId: string
  // The requested assessment as stored by A6.4 (it belongs to this Claim; the service has checked).
  assessment: { outcome: string; assemblyFingerprint: string; createdByUserId: string }
  latest: LatestDecision
  // The authority derived on the same snapshot, before this decision.
  authority: ReviewAuthorityState
  // For an APPROVE: the A6.4 owner's composition of the requested assessment's draft, now.
  requestedCurrentness: Currentness
}

export type Admission = { ok: true } | { ok: false; code: ClaimReviewErrorCode; message: string }

const refuse = (code: ClaimReviewErrorCode, message: string): Admission => ({ ok: false, code, message })

// §5 — whether the requested decision may be appended to this Claim's history.
export function admitDecision(facts: AdmissionFacts): Admission {
  const { request, assessment } = facts
  // D6 — every decision binds the exact assessment the reviewer saw, by its own stored fingerprint.
  if (request.assemblyFingerprint !== assessment.assemblyFingerprint) return refuse('CLAIM_REVIEW_STALE', 'the assembly fingerprint is not the one recorded for this draft assessment')

  switch (request.decisionCode) {
    case 'APPROVE': {
      if (assessment.outcome !== 'REVIEWABLE') return refuse('CLAIM_REVIEW_NOT_REVIEWABLE', `a ${assessment.outcome} draft assessment cannot be approved`)
      // §4 — the reviewer is neither the Claim's creator nor the assessment's creator. With no other
      // authorized reviewer the approval is refused; no approver is ever substituted.
      if (facts.reviewerUserId === facts.claimCreatorUserId || facts.reviewerUserId === assessment.createdByUserId)
        return refuse('CLAIM_REVIEW_SEPARATION_REQUIRED', 'the reviewer created this claim or this draft assessment; a separate authorized reviewer must decide')
      // §6 — one current authority at a time: a current approval is withdrawn explicitly before another.
      if (facts.authority === 'APPROVED_CURRENT') return refuse('CLAIM_REVIEW_CONFLICT', 'an approval of this claim is still current; it must be revoked before another approval')
      const now = facts.requestedCurrentness
      if (now === null || now.outcome !== 'REVIEWABLE' || now.assemblyFingerprint !== assessment.assemblyFingerprint)
        return refuse('CLAIM_REVIEW_STALE', 'the reviewed draft is no longer current; a fresh draft assessment is required')
      return { ok: true }
    }
    case 'RETURN':
    case 'REJECT':
      // D4 — a current approval is never ended implicitly by a return or rejection.
      if (facts.authority === 'APPROVED_CURRENT') return refuse('CLAIM_REVIEW_CONFLICT', 'an approval of this claim is still current; it must be revoked first')
      return { ok: true }
    case 'REVOKE': {
      // §5/D5 — only the Claim's latest decision can be revoked, and it must be an APPROVE (current or
      // stale) of the same assessment; a revoked or superseded approval is never the latest APPROVE.
      const latest = facts.latest
      if (latest === null || latest.decisionCode !== 'APPROVE' || latest.id !== request.referencedApprovalId)
        return refuse('CLAIM_REVIEW_CONFLICT', "the referenced approval is not this claim's latest decision")
      if (latest.draftAssessmentId !== request.draftAssessmentId) return refuse('CLAIM_REVIEW_CONFLICT', 'the revocation names another draft assessment than the approval it withdraws')
      return { ok: true }
    }
  }
}

export const nextSequence = (latest: LatestDecision) => (latest?.sequence ?? 0) + 1

// §10 — one business audit action per decision code.
const auditActions = {
  APPROVE: 'claim_review.approved',
  RETURN: 'claim_review.returned',
  REJECT: 'claim_review.rejected',
  REVOKE: 'claim_review.revoked',
} as const satisfies Record<ReviewDecisionCode, string>

export const auditActionOf = (decisionCode: ReviewDecisionCode) => auditActions[decisionCode]
