import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'
import { REVENUE_SOURCE_KIND_RESERVED, REVENUE_SOURCE_KIND_SYNTHETIC, SOURCE_REFERENCE_PATTERN, type RevenueSourceEvidenceRequest } from './revenue-evidence.types.ts'

// A7.1 §5 — the strict registration request: exactly { sourceKind, sourceReference }. The frozen submission
// comes from the path and the actor from the session. Server-owned fields, and every field that would turn a
// provenance record into a payer verdict, a payment, a status or free text, are refused by name, never by
// value: nothing is ignored silently.

export const isRevenueEvidenceUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const requestFields = ['sourceKind', 'sourceReference'] as const

const refusedByName = [
  // server-owned identity, contract, actor and time
  'id',
  'revenueSourceEvidenceId',
  'organizationId',
  'claimSubmissionId',
  'submissionId',
  'claimId',
  'sourceVersion',
  'contractVersion',
  'sourceDigestSha256',
  'digest',
  'receivedAt',
  'recordedAt',
  'createdAt',
  'recordedByUserId',
  'actorUserId',
  // a verdict, money or status A7.1 never asserts
  'verified',
  'verificationStatus',
  'status',
  'state',
  'paid',
  'paidAmount',
  'amount',
  'currency',
  'currencyCode',
  'allowedAmount',
  'patientShare',
  'denied',
  'denialReason',
  'denialCode',
  'adjudication',
  'remittance',
  'payment',
  'settlement',
  // external facts and raw content
  'externalTimestamp',
  'externalReference',
  'payer',
  'payerId',
  'payerResponse',
  'payload',
  'rawMessage',
  'url',
  'note',
  'comment',
] as const

export function validateRevenueSourceEvidenceBody(body: unknown): Outcome<RevenueSourceEvidenceRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { sourceKind, sourceReference } body is required' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server owns them or A7.1 never asserts them` }
  const unknown = keys.filter((key) => !(requestFields as readonly string[]).includes(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (body.sourceKind === REVENUE_SOURCE_KIND_RESERVED)
    return { ok: false, message: `${REVENUE_SOURCE_KIND_RESERVED} is not available: no authenticated integration artifact exists; only ${REVENUE_SOURCE_KIND_SYNTHETIC} can be registered` }
  if (body.sourceKind !== REVENUE_SOURCE_KIND_SYNTHETIC) return { ok: false, message: `sourceKind must be ${REVENUE_SOURCE_KIND_SYNTHETIC}` }
  if (typeof body.sourceReference !== 'string' || !SOURCE_REFERENCE_PATTERN.test(body.sourceReference))
    return { ok: false, message: 'sourceReference must be an opaque reference of 3-64 upper-case letters, digits, ".", "_" or "-", starting with a letter or digit' }
  return { ok: true, value: { sourceKind: REVENUE_SOURCE_KIND_SYNTHETIC, sourceReference: body.sourceReference } }
}
