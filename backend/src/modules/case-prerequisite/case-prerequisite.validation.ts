import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A7.5 §6 — the strict assessment request: no field at all. The exact case comes from the path, the actor from the
// session, and the codes, contract, copied case digest, organization and instant are derived by the server from the
// owners' stored facts. Server-owned fields, and every field that would turn an assessment into a verdict, money,
// a status, a fingerprint or a client-chosen case, are refused by name; anything else is refused as unknown.

export const isPrerequisiteUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const refusedByName = [
  'id',
  'assessmentId',
  'caseId',
  'evidenceCaseId',
  'organizationId',
  'claimSubmissionId',
  'claimId',
  'sourceEvidenceId',
  'contractVersion',
  'assessmentCode',
  'basisCode',
  'caseManifestSha256',
  'manifestSha256',
  'fingerprint',
  'hash',
  'recordedByUserId',
  'actorUserId',
  'recordedAt',
  'createdAt',
  'date',
  'ready',
  'closed',
  'closure',
  'status',
  'state',
  'latest',
  'paid',
  'paidAmount',
  'amount',
  'fee',
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
export function validatePrerequisiteBody(body: unknown): Outcome<Record<string, never>> {
  if (body === undefined) return { ok: true, value: {} }
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be empty: the server derives every assessment value' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server derives or owns them, or A7.5 never asserts them` }
  if (keys.length > 0) return { ok: false, message: `unknown field(s): ${keys.join(', ')}` }
  return { ok: true, value: {} }
}
