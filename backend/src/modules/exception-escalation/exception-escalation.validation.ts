import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import {
  type EscalationEventCode,
  type EscalationEventRequest,
  type EscalationReasonCode,
  type FollowupCode,
  type ReturnReasonCode,
  escalationEventCodes,
  escalationReasonCodes,
  followupCodes,
  returnReasonCodes,
} from './exception-escalation.types.ts'

// A8.8 §3/§4 — the request is one event code and exactly that event's own controlled attributes. Any other field (an
// id, actor, membership, tenant, sequence, time, status, state, outcome, current or latest selector, source kind, free
// text, URL, attachment, payload, amount, clinical value or narrative) is refused, never ignored. Whether the target is
// an eligible member, the cited events the open escalation and its acknowledgement, the source an exact A8.3/A8.6
// record of the intake, and the event a legal next step, is decided later against the owners and the history.

export const isEscalationUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const KEYS_OF: Record<EscalationEventCode, readonly string[]> = {
  ESCALATE_FOR_REVIEW: ['eventCode', 'reasonCode', 'targetMemberId'],
  ACKNOWLEDGE_ESCALATION: ['eventCode', 'escalationEventId'],
  RECORD_FOLLOWUP: ['eventCode', 'acknowledgementEventId', 'followupCode', 'sourceEventId'],
  RETURN_TO_OWNER: ['eventCode', 'escalationEventId', 'returnReasonCode'],
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export type ValidatedEvent = { ok: true; value: EscalationEventRequest } | { ok: false; code: 'VALIDATION_ERROR'; message: string }

const invalid = (message: string): ValidatedEvent => ({ ok: false, code: 'VALIDATION_ERROR', message })

export function validateEscalationEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return invalid('the request body must be an object')
  const fields = body as Record<string, unknown>
  if (!oneOf(escalationEventCodes, fields.eventCode)) return invalid('unknown escalation event code')
  const eventCode = fields.eventCode
  const allowed = KEYS_OF[eventCode]
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return invalid(`unsupported field(s) for ${eventCode}: ${unknown.join(', ')}`)
  const missing = allowed.filter((key) => !(key in fields))
  if (missing.length > 0) return invalid(`missing field(s): ${missing.join(', ')}`)
  if (eventCode === 'ESCALATE_FOR_REVIEW') {
    if (!oneOf(escalationReasonCodes, fields.reasonCode)) return invalid('unknown escalation reason code')
    if (!isEscalationUuid(fields.targetMemberId)) return invalid('invalid target member id')
    return { ok: true, value: { eventCode, reasonCode: fields.reasonCode as EscalationReasonCode, targetMemberId: fields.targetMemberId.toLowerCase() } }
  }
  if (eventCode === 'ACKNOWLEDGE_ESCALATION') {
    if (!isEscalationUuid(fields.escalationEventId)) return invalid('invalid escalation event id')
    return { ok: true, value: { eventCode, escalationEventId: fields.escalationEventId.toLowerCase() } }
  }
  if (eventCode === 'RECORD_FOLLOWUP') {
    if (!isEscalationUuid(fields.acknowledgementEventId)) return invalid('invalid acknowledgement event id')
    if (!oneOf(followupCodes, fields.followupCode)) return invalid('unknown follow-up code')
    if (!isEscalationUuid(fields.sourceEventId)) return invalid('invalid source event id')
    return {
      ok: true,
      value: { eventCode, acknowledgementEventId: fields.acknowledgementEventId.toLowerCase(), followupCode: fields.followupCode as FollowupCode, sourceEventId: fields.sourceEventId.toLowerCase() },
    }
  }
  if (!isEscalationUuid(fields.escalationEventId)) return invalid('invalid escalation event id')
  if (!oneOf(returnReasonCodes, fields.returnReasonCode)) return invalid('unknown return reason code')
  return { ok: true, value: { eventCode, escalationEventId: fields.escalationEventId.toLowerCase(), returnReasonCode: fields.returnReasonCode as ReturnReasonCode } }
}

// The reads take no input but the two path ids: any query parameter or body is refused.
export function refusedReadRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'the read carries no body'
  return null
}
