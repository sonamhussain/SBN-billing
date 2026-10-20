import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'
import { correctionReasonCodes, type CorrectionLinkRequest, type CorrectionReasonCode } from './claim-correction.types.ts'

// A6.9 §7 — the strict correction request: exactly { priorSubmissionId, correctedSubmissionId, reasonCode }.
// The Claim comes from the path and the actor from the session; actor, Claim, instants, status, payer,
// destination, digests and free text are refused by name, never by value. A self link is detectable from
// the body alone and is refused here (the database CHECK is the backstop).

export const isClaimCorrectionUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const requestFields = ['priorSubmissionId', 'correctedSubmissionId', 'reasonCode'] as const

const refusedByName = [
  'id',
  'correctionLinkId',
  'claimId',
  'recordedByUserId',
  'actorUserId',
  'recordedAt',
  'createdAt',
  'contractVersion',
  'status',
  'state',
  'sequence',
  'note',
  'reason',
  'comment',
  'payer',
  'destination',
  'externalReference',
  'resubmissionId',
  'payloadSha256',
] as const

const isReasonCode = (value: unknown): value is CorrectionReasonCode => typeof value === 'string' && (correctionReasonCodes as readonly string[]).includes(value)

export function validateCorrectionLinkBody(body: unknown): Outcome<CorrectionLinkRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { priorSubmissionId, correctedSubmissionId, reasonCode } body is required' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server owns them` }
  const unknown = keys.filter((key) => !(requestFields as readonly string[]).includes(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (!isClaimCorrectionUuid(body.priorSubmissionId)) return { ok: false, message: 'priorSubmissionId is required and must be a UUID' }
  if (!isClaimCorrectionUuid(body.correctedSubmissionId)) return { ok: false, message: 'correctedSubmissionId is required and must be a UUID' }
  if (!isReasonCode(body.reasonCode)) return { ok: false, message: `reasonCode must be one of ${correctionReasonCodes.join(', ')}` }
  const priorSubmissionId = body.priorSubmissionId.toLowerCase()
  const correctedSubmissionId = body.correctedSubmissionId.toLowerCase()
  if (priorSubmissionId === correctedSubmissionId) return { ok: false, message: 'a freeze cannot correct itself: priorSubmissionId and correctedSubmissionId must differ' }
  return { ok: true, value: { priorSubmissionId, correctedSubmissionId, reasonCode: body.reasonCode } }
}
