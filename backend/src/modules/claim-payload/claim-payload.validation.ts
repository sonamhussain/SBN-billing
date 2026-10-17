import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A6.6 §6 step 8 — the strict preview request. The caller names the exact A6.4 draft assessment and the
// exact A6.5 APPROVE decision; the Claim comes from the path. Nothing else is accepted: no client-supplied
// payload, bytes, digest, totals, amounts, codes, jurisdiction, profile or "latest" selector. Server-owned
// and business fields are refused by name, never by value.

export const isClaimPayloadUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const requestFields = ['draftAssessmentId', 'approvalDecisionId'] as const

const refusedByName = [
  'claimId',
  'payload',
  'bytes',
  'sha256',
  'digest',
  'previewDigestSha256',
  'schemaVersion',
  'pricingRunId',
  'total',
  'totalExtendedAmount',
  'amount',
  'currencyCode',
  'lines',
  'diagnoses',
  'jurisdictionCode',
  'reviewerUserId',
  'latest',
] as const

export type PreviewRequest = { draftAssessmentId: string; approvalDecisionId: string }

export function validatePreviewBody(body: unknown): Outcome<PreviewRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { draftAssessmentId, approvalDecisionId } body is required' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the canonical payload is composed by the server from its owners` }
  const unknown = keys.filter((key) => !(requestFields as readonly string[]).includes(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (!isClaimPayloadUuid(body.draftAssessmentId)) return { ok: false, message: 'draftAssessmentId is required and must be a UUID' }
  if (!isClaimPayloadUuid(body.approvalDecisionId)) return { ok: false, message: 'approvalDecisionId is required and must be a UUID' }
  return { ok: true, value: { draftAssessmentId: body.draftAssessmentId.toLowerCase(), approvalDecisionId: body.approvalDecisionId.toLowerCase() } }
}
