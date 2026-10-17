import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'
import type { FreezeRequest } from './claim-submission.types.ts'

// A6.7 §2/§6 — the strict freeze request. The caller names the exact A6.4 draft assessment and the exact
// A6.5 APPROVE decision; the Claim comes from the path and the actor from the session. Nothing else is
// accepted: no client-supplied payload, bytes, digest, amount, review state, submission state, sequence,
// actor or instant. Server-owned and business fields are refused by name, never by value.

export const isClaimSubmissionUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const requestFields = ['draftAssessmentId', 'approvalDecisionId'] as const

const refusedByName = [
  'id',
  'submissionId',
  'claimId',
  'pricingRunId',
  'payload',
  'canonicalPayloadBytes',
  'bytes',
  'payloadSha256',
  'sha256',
  'digest',
  'manifest',
  'manifestSha256',
  'packageSealSha256',
  'approvedAssemblyFingerprint',
  'assemblyFingerprint',
  'total',
  'totalExtendedAmount',
  'amount',
  'decisionCode',
  'reviewState',
  'state',
  'status',
  'sequence',
  'createdByUserId',
  'actorUserId',
  'frozenAt',
  'submittedAt',
  'createdAt',
  'latest',
] as const

export function validateFreezeBody(body: unknown): Outcome<FreezeRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { draftAssessmentId, approvalDecisionId } body is required' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the freeze is composed by the server from its owners` }
  const unknown = keys.filter((key) => !(requestFields as readonly string[]).includes(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (!isClaimSubmissionUuid(body.draftAssessmentId)) return { ok: false, message: 'draftAssessmentId is required and must be a UUID' }
  if (!isClaimSubmissionUuid(body.approvalDecisionId)) return { ok: false, message: 'approvalDecisionId is required and must be a UUID' }
  return { ok: true, value: { draftAssessmentId: body.draftAssessmentId.toLowerCase(), approvalDecisionId: body.approvalDecisionId.toLowerCase() } }
}
