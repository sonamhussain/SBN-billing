import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import { returnReasonCodes, triageCategoryCodes, triageEventCodes, triagePriorityCodes, type TriageEventCode, type TriageEventRequest } from './exception-triage.types.ts'

// A8.2 §5 — the request is one event code and exactly that event's own controlled attributes. Any other field (an
// id, actor, tenant, sequence, state, time, member on a classification, context, payload, amount, clinical value or
// narrative) is refused, never ignored. Whether the transition is LEGAL is decided later, against the history.

export const isTriageUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const KEYS_OF: Record<TriageEventCode, readonly string[]> = {
  TRIAGE_CLASSIFY: ['eventCode', 'categoryCode', 'priorityCode'],
  ASSIGN_OWNER: ['eventCode', 'assignedMemberId'],
  REASSIGN_OWNER: ['eventCode', 'assignedMemberId'],
  RETURN_TO_TRIAGE: ['eventCode', 'reasonCode'],
}

export type ValidatedEvent = { ok: true; value: TriageEventRequest } | { ok: false; message: string }

export function validateTriageEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be an object' }
  const { eventCode } = body as Record<string, unknown>
  if (typeof eventCode !== 'string' || !(triageEventCodes as readonly string[]).includes(eventCode)) return { ok: false, message: 'unknown triage event code' }
  const allowed = KEYS_OF[eventCode as TriageEventCode]
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return { ok: false, message: `unsupported field(s) for ${eventCode}: ${unknown.join(', ')}` }
  const missing = allowed.filter((key) => !(key in body))
  if (missing.length > 0) return { ok: false, message: `missing field(s): ${missing.join(', ')}` }
  const fields = body as Record<string, unknown>
  switch (eventCode as TriageEventCode) {
    case 'TRIAGE_CLASSIFY':
      if (typeof fields.categoryCode !== 'string' || !(triageCategoryCodes as readonly string[]).includes(fields.categoryCode)) return { ok: false, message: 'unknown triage category' }
      if (typeof fields.priorityCode !== 'string' || !(triagePriorityCodes as readonly string[]).includes(fields.priorityCode)) return { ok: false, message: 'unknown triage priority' }
      return { ok: true, value: { eventCode: 'TRIAGE_CLASSIFY', categoryCode: fields.categoryCode as never, priorityCode: fields.priorityCode as never } }
    case 'ASSIGN_OWNER':
    case 'REASSIGN_OWNER':
      if (!isTriageUuid(fields.assignedMemberId)) return { ok: false, message: 'invalid member id' }
      return { ok: true, value: { eventCode: eventCode as 'ASSIGN_OWNER' | 'REASSIGN_OWNER', assignedMemberId: fields.assignedMemberId.toLowerCase() } }
    case 'RETURN_TO_TRIAGE':
      if (typeof fields.reasonCode !== 'string' || !(returnReasonCodes as readonly string[]).includes(fields.reasonCode)) return { ok: false, message: 'unknown return reason' }
      return { ok: true, value: { eventCode: 'RETURN_TO_TRIAGE', reasonCode: fields.reasonCode as never } }
  }
}

// The reads take no input but the two path ids: any query parameter or body is refused.
export function refusedReadRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'the read carries no body'
  return null
}
