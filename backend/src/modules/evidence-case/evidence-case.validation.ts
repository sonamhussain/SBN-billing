import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A7.4 §6 — the strict case request: no field at all. The frozen submission comes from the path, the actor from the
// session, and the code, counts, items, digest, organization and every link are derived by the server from the
// owners' stored facts. Server-owned fields, and every field that would turn a case into a verdict, money, a
// status or a client-chosen source list, are refused by name; anything else is refused as unknown.

export const isCaseUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const refusedByName = [
  'id',
  'caseId',
  'organizationId',
  'claimSubmissionId',
  'claimId',
  'contractVersion',
  'assemblyCode',
  'sourceCount',
  'classifiedCount',
  'readinessCount',
  'itemCount',
  'items',
  'sources',
  'sourceEvidenceIds',
  'classificationIds',
  'readinessIds',
  'manifestSha256',
  'manifest',
  'hash',
  'recordedByUserId',
  'actorUserId',
  'recordedAt',
  'createdAt',
  'ready',
  'adjudicated',
  'status',
  'state',
  'paid',
  'paidAmount',
  'amount',
  'currency',
  'balance',
  'denied',
  'settlement',
  'remittance',
  'payment',
  'payer',
  'payerId',
  'payload',
  'note',
  'comment',
] as const

// An absent body or an empty object only.
export function validateCaseBody(body: unknown): Outcome<Record<string, never>> {
  if (body === undefined) return { ok: true, value: {} }
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be empty: the server derives every case value' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server derives or owns them, or A7.4 never asserts them` }
  if (keys.length > 0) return { ok: false, message: `unknown field(s): ${keys.join(', ')}` }
  return { ok: true, value: {} }
}
