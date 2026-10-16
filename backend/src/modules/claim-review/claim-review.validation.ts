import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'
import { reviewDecisionCodes, reviewReasonCodes, type ReviewDecisionCode, type ReviewDecisionRequest, type ReviewReasonCode } from './claim-review.types.ts'

// A6.5 §5 — the strict request. The client names the exact assessment it reviewed, that assessment's
// fingerprint, the decision and (when the decision needs one) a controlled reason or the approval being
// revoked. The Claim comes from the path; the reviewer from the session; sequence, approval fingerprint and
// every instant from the server. Those fields are refused by name, never by value.

export const isClaimReviewUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const fingerprintShape = /^[0-9a-f]{64}$/

const requestFields = ['draftAssessmentId', 'assemblyFingerprint', 'decisionCode', 'reasonCode', 'referencedApprovalId'] as const

const serverOwnedFields = [
  'id',
  'claimId',
  'reviewerUserId',
  'actorUserId',
  'sequence',
  'approvalFingerprint',
  'reviewContractVersion',
  'reviewedAt',
  'createdAt',
  'total',
  'payload',
] as const

const isDecisionCode = (value: unknown): value is ReviewDecisionCode => typeof value === 'string' && (reviewDecisionCodes as readonly string[]).includes(value)
const isReasonCode = (value: unknown): value is ReviewReasonCode => typeof value === 'string' && (reviewReasonCodes as readonly string[]).includes(value)

export function validateReviewDecisionBody(body: unknown): Outcome<ReviewDecisionRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { draftAssessmentId, assemblyFingerprint, decisionCode } body is required' }
  const keys = Object.keys(body)
  const forged = serverOwnedFields.filter((field) => keys.includes(field))
  if (forged.length > 0) return { ok: false, message: `${forged.join(', ')} is owned by the server and cannot be supplied` }
  const unknown = keys.filter((key) => !(requestFields as readonly string[]).includes(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (!isClaimReviewUuid(body.draftAssessmentId)) return { ok: false, message: 'draftAssessmentId is required and must be a UUID' }
  if (typeof body.assemblyFingerprint !== 'string' || !fingerprintShape.test(body.assemblyFingerprint))
    return { ok: false, message: 'assemblyFingerprint is required and must be a 64-character lowercase SHA-256 hex digest' }
  if (!isDecisionCode(body.decisionCode)) return { ok: false, message: `decisionCode must be one of ${reviewDecisionCodes.join(', ')}` }
  const decisionCode = body.decisionCode
  const hasReason = keys.includes('reasonCode')
  const hasTarget = keys.includes('referencedApprovalId')
  if (hasReason && !isReasonCode(body.reasonCode)) return { ok: false, message: `reasonCode must be one of ${reviewReasonCodes.join(', ')}` }

  if (decisionCode === 'APPROVE') {
    if (hasReason || hasTarget) return { ok: false, message: 'an APPROVE carries no reasonCode and no referencedApprovalId' }
  } else if (decisionCode === 'RETURN' || decisionCode === 'REJECT') {
    if (!hasReason) return { ok: false, message: `a ${decisionCode} requires a reasonCode` }
    if (hasTarget) return { ok: false, message: `a ${decisionCode} carries no referencedApprovalId` }
  } else if (!isClaimReviewUuid(body.referencedApprovalId)) {
    return { ok: false, message: 'a REVOKE requires referencedApprovalId, the UUID of the approval it withdraws' }
  }

  return {
    ok: true,
    value: {
      draftAssessmentId: body.draftAssessmentId,
      assemblyFingerprint: body.assemblyFingerprint,
      decisionCode,
      reasonCode: hasReason ? (body.reasonCode as ReviewReasonCode) : null,
      referencedApprovalId: decisionCode === 'REVOKE' ? (body.referencedApprovalId as string) : null,
    },
  }
}
