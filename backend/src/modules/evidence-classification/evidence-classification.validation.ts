import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A7.2 §6 — the strict classification request: no field at all. The source record comes from the path, the
// actor from the session, and the classification, its outcome, reason, contract and fingerprint are derived by
// the server from the source's own facts. Server-owned fields, and every field that would turn a classification
// into a verdict, a payment, a status or free text, are refused by name; anything else is refused as unknown.

export const isEvidenceClassificationUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const refusedByName = [
  'id',
  'classificationId',
  'organizationId',
  'sourceEvidenceId',
  'claimSubmissionId',
  'contractVersion',
  'classificationCode',
  'normalizationOutcome',
  'reasonCode',
  'sourceFingerprintSha256',
  'fingerprint',
  'recordedByUserId',
  'actorUserId',
  'recordedAt',
  'createdAt',
  'sourceKind',
  'sourceReference',
  'sourceVersion',
  'verified',
  'verificationStatus',
  'status',
  'state',
  'paid',
  'paidAmount',
  'amount',
  'currency',
  'denied',
  'denialReason',
  'adjudication',
  'remittance',
  'payment',
  'externalTimestamp',
  'payer',
  'payerId',
  'payload',
  'note',
  'comment',
] as const

// An absent body or an empty object only.
export function validateClassificationBody(body: unknown): Outcome<Record<string, never>> {
  if (body === undefined) return { ok: true, value: {} }
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be empty: the server derives every classification value' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server derives or owns them, or A7.2 never asserts them` }
  if (keys.length > 0) return { ok: false, message: `unknown field(s): ${keys.join(', ')}` }
  return { ok: true, value: {} }
}
