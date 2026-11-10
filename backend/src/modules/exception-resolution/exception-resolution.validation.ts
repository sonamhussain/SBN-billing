import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import {
  type DecisionCode,
  type RequestReasonCode,
  type ResolutionEventCode,
  type ResolutionEventRequest,
  type ReturnReasonCode,
  decisionCodes,
  requestReasonCodes,
  resolutionEventCodes,
  returnReasonCodes,
} from './exception-resolution.types.ts'

// A8.7 §3/§6 — the request is one event code and exactly that event's own controlled attributes. Any other field (an
// id, actor, membership, tenant, sequence, time, status, state, outcome, current or latest selector, text, URL,
// attachment, payload, amount, clinical value or narrative) is refused, never ignored. Whether the cited verification
// is the intake's verified A8.6 record, the request the pending one, and the event a legal next step, is decided later
// against the owners and the history.

export const isResolutionUuid = (value: unknown): value is string => isClaimStructureUuid(value)

// A return carries its reason; a confirmation carries no reason field at all.
const KEYS_OF: Record<ResolutionEventCode, readonly string[]> = {
  REQUEST_INTERNAL_RESOLUTION: ['eventCode', 'verificationEventId', 'reasonCode'],
  DECIDE_INTERNAL_RESOLUTION: ['eventCode', 'requestEventId', 'decisionCode'],
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export type ValidatedEvent = { ok: true; value: ResolutionEventRequest } | { ok: false; code: 'VALIDATION_ERROR'; message: string }

const invalid = (message: string): ValidatedEvent => ({ ok: false, code: 'VALIDATION_ERROR', message })

export function validateResolutionEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return invalid('the request body must be an object')
  const fields = body as Record<string, unknown>
  if (!oneOf(resolutionEventCodes, fields.eventCode)) return invalid('unknown resolution event code')
  const eventCode = fields.eventCode
  const allowed = eventCode === 'DECIDE_INTERNAL_RESOLUTION' && fields.decisionCode === 'RETURN_FOR_REWORK' ? [...KEYS_OF.DECIDE_INTERNAL_RESOLUTION, 'returnReasonCode'] : KEYS_OF[eventCode]
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key))
  if (unknown.length > 0)
    return invalid(`unsupported field(s) for ${eventCode}${eventCode === 'DECIDE_INTERNAL_RESOLUTION' ? ` with ${String(fields.decisionCode)}` : ''}: ${unknown.join(', ')}`)
  const missing = allowed.filter((key) => !(key in fields))
  if (missing.length > 0) return invalid(`missing field(s): ${missing.join(', ')}`)
  if (eventCode === 'REQUEST_INTERNAL_RESOLUTION') {
    if (!isResolutionUuid(fields.verificationEventId)) return invalid('invalid verification event id')
    if (!oneOf(requestReasonCodes, fields.reasonCode)) return invalid('unknown request reason code')
    return { ok: true, value: { eventCode, verificationEventId: fields.verificationEventId.toLowerCase(), reasonCode: fields.reasonCode as RequestReasonCode } }
  }
  if (!isResolutionUuid(fields.requestEventId)) return invalid('invalid request event id')
  if (!oneOf(decisionCodes, fields.decisionCode)) return invalid('unknown decision code')
  if (fields.decisionCode === 'RETURN_FOR_REWORK' && !oneOf(returnReasonCodes, fields.returnReasonCode)) return invalid('a return carries a controlled return reason code')
  return {
    ok: true,
    value: {
      eventCode,
      requestEventId: fields.requestEventId.toLowerCase(),
      decisionCode: fields.decisionCode as DecisionCode,
      returnReasonCode: fields.decisionCode === 'RETURN_FOR_REWORK' ? (fields.returnReasonCode as ReturnReasonCode) : null,
    },
  }
}

// The reads take no input but the two path ids: any query parameter or body is refused.
export function refusedReadRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'the read carries no body'
  return null
}
