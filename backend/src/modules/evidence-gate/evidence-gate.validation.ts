import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A7.3 §6 — the strict readiness request: no field at all. The classification comes from the path, the actor from
// the session, and the readiness, reason, contract, source, organization and fingerprint are derived by the server
// from the stored classification. Server-owned fields, and every field that would turn a readiness result into a
// verdict, money, a status or free text, are refused by name; anything else is refused as unknown.

export const isReadinessUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const refusedByName = [
  'id',
  'readinessId',
  'organizationId',
  'classificationId',
  'sourceEvidenceId',
  'claimSubmissionId',
  'contractVersion',
  'readinessCode',
  'reasonCode',
  'classificationFingerprintSha256',
  'fingerprint',
  'recordedByUserId',
  'actorUserId',
  'recordedAt',
  'createdAt',
  'ready',
  'adjudicated',
  'adjudication',
  'verified',
  'status',
  'state',
  'paid',
  'paidAmount',
  'allowedAmount',
  'amount',
  'currency',
  'denied',
  'denialReason',
  'remittance',
  'settlement',
  'payment',
  'balance',
  'payer',
  'payerId',
  'payerResponse',
  'externalReference',
  'serviceDate',
  'payload',
  'note',
  'comment',
] as const

// An absent body or an empty object only.
export function validateReadinessBody(body: unknown): Outcome<Record<string, never>> {
  if (body === undefined) return { ok: true, value: {} }
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be empty: the server derives every readiness value' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server derives or owns them, or A7.3 never asserts them` }
  if (keys.length > 0) return { ok: false, message: `unknown field(s): ${keys.join(', ')}` }
  return { ok: true, value: {} }
}
