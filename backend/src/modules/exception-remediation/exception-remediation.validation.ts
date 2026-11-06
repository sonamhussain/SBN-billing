import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import {
  type ActionCode,
  type DecisionCode,
  type RationaleCode,
  type RemediationEventCode,
  type RemediationEventRequest,
  type ReviewReasonCode,
  actionCodes,
  decisionCodes,
  rationaleCodes,
  remediationEventCodes,
  reviewReasonCodes,
} from './exception-remediation.types.ts'

// A8.5 §4 — the request is one event code and exactly that event's own controlled attributes. Any other field (an
// id, actor, membership, tenant, sequence, time, status, state, finding text, URL, attachment, payload, amount,
// clinical value or narrative) is refused, never ignored. Whether the finding is an A8.3 finding of this intake, and
// whether the event is a legal next step, is decided later against the owners and the history.

export const isRemediationUuid = (value: unknown): value is string => isClaimStructureUuid(value)

// A return carries its reason; an approval carries no reason field at all.
const KEYS_OF: Record<RemediationEventCode, readonly string[]> = {
  PROPOSE_ACTION: ['eventCode', 'actionCode', 'findingEventId', 'rationaleCode'],
  REVIEW_ACTION: ['eventCode', 'proposalEventId', 'decisionCode'],
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export type ValidatedEvent = { ok: true; value: RemediationEventRequest } | { ok: false; message: string }

export function validateRemediationEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be an object' }
  const fields = body as Record<string, unknown>
  if (!oneOf(remediationEventCodes, fields.eventCode)) return { ok: false, message: 'unknown remediation event code' }
  const eventCode = fields.eventCode
  const allowed = eventCode === 'REVIEW_ACTION' && fields.decisionCode === 'RETURN_PROPOSAL' ? [...KEYS_OF.REVIEW_ACTION, 'reviewReasonCode'] : KEYS_OF[eventCode]
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return { ok: false, message: `unsupported field(s) for ${eventCode}${eventCode === 'REVIEW_ACTION' ? ` with ${String(fields.decisionCode)}` : ''}: ${unknown.join(', ')}` }
  const missing = allowed.filter((key) => !(key in fields))
  if (missing.length > 0) return { ok: false, message: `missing field(s): ${missing.join(', ')}` }
  if (eventCode === 'PROPOSE_ACTION') {
    if (!oneOf(actionCodes, fields.actionCode)) return { ok: false, message: 'unknown action code' }
    if (!isRemediationUuid(fields.findingEventId)) return { ok: false, message: 'invalid finding event id' }
    if (!oneOf(rationaleCodes, fields.rationaleCode)) return { ok: false, message: 'unknown rationale code' }
    return { ok: true, value: { eventCode, actionCode: fields.actionCode as ActionCode, findingEventId: fields.findingEventId.toLowerCase(), rationaleCode: fields.rationaleCode as RationaleCode } }
  }
  if (!isRemediationUuid(fields.proposalEventId)) return { ok: false, message: 'invalid proposal event id' }
  if (!oneOf(decisionCodes, fields.decisionCode)) return { ok: false, message: 'unknown decision code' }
  if (fields.decisionCode === 'RETURN_PROPOSAL' && !oneOf(reviewReasonCodes, fields.reviewReasonCode)) return { ok: false, message: 'a return carries a controlled review reason code' }
  return {
    ok: true,
    value: {
      eventCode,
      proposalEventId: fields.proposalEventId.toLowerCase(),
      decisionCode: fields.decisionCode as DecisionCode,
      reviewReasonCode: fields.decisionCode === 'RETURN_PROPOSAL' ? (fields.reviewReasonCode as ReviewReasonCode) : null,
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
