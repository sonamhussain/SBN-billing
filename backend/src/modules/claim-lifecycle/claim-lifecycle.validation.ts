import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'
import { lifecycleEventCodes, lifecycleReasonCodes, reasonRequired, type LifecycleEventCode, type LifecycleEventRequest, type LifecycleReasonCode } from './claim-lifecycle.types.ts'

// A6.8 §6 — the strict lifecycle request: exactly { eventCode, reasonCode }. reasonCode is one controlled
// code for every event except AUTHORIZE_RELEASE, where it is null. The submission comes from the path and
// the actor from the session; actor, sequence, state, instants, destinations, payer data, external
// references and digests are refused by name, never by value.

export const isClaimLifecycleUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const requestFields = ['eventCode', 'reasonCode'] as const

const refusedByName = [
  'id',
  'submissionId',
  'claimId',
  'actorUserId',
  'createdByUserId',
  'sequence',
  'status',
  'state',
  'currentState',
  'occurredAt',
  'createdAt',
  'timestamp',
  'lifecycleContractVersion',
  'destination',
  'payer',
  'payerId',
  'externalReference',
  'payloadDigest',
  'payloadSha256',
  'idempotencyKey',
] as const

const isEventCode = (value: unknown): value is LifecycleEventCode => typeof value === 'string' && (lifecycleEventCodes as readonly string[]).includes(value)
const isReasonCode = (value: unknown): value is LifecycleReasonCode => typeof value === 'string' && (lifecycleReasonCodes as readonly string[]).includes(value)

export function validateLifecycleEventBody(body: unknown): Outcome<LifecycleEventRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { eventCode, reasonCode } body is required' }
  const keys = Object.keys(body)
  const refused = refusedByName.filter((field) => keys.includes(field))
  if (refused.length > 0) return { ok: false, message: `${refused.join(', ')} cannot be supplied: the server owns them` }
  const unknown = keys.filter((key) => !(requestFields as readonly string[]).includes(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (!keys.includes('eventCode') || !keys.includes('reasonCode')) return { ok: false, message: 'both eventCode and reasonCode are required (reasonCode is null for AUTHORIZE_RELEASE)' }
  if (!isEventCode(body.eventCode)) return { ok: false, message: `eventCode must be one of ${lifecycleEventCodes.join(', ')}` }
  const eventCode = body.eventCode
  if (!reasonRequired(eventCode)) {
    if (body.reasonCode !== null) return { ok: false, message: 'AUTHORIZE_RELEASE carries no reason: reasonCode must be null' }
    return { ok: true, value: { eventCode, reasonCode: null } }
  }
  if (!isReasonCode(body.reasonCode)) return { ok: false, message: `${eventCode} requires reasonCode, one of ${lifecycleReasonCodes.join(', ')}` }
  return { ok: true, value: { eventCode, reasonCode: body.reasonCode } }
}
