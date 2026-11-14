import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import { type BasisReferenceKind, type ClosureEventRequest, type ClosureReasonCode, REASON_OF_BASIS, basisReferenceKinds, closureEventCodes, closureReasonCodes } from './exception-closure.types.ts'

// A8.9 §4 — the request is the event code and exactly its own controlled attributes. Any other field (an id, actor,
// membership, tenant, sequence, time, version, status, state, outcome, current or latest selector, basis owner contract,
// free text, URL, attachment, payload, amount, clinical value or narrative) is refused, never ignored. Whether the
// decision is the intake's confirmed A8.7 decision, the basis the intake's own and the intake eligible, is decided later
// against the owners and the history.

export const isClosureUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const KEYS = ['eventCode', 'resolutionDecisionEventId', 'closureReasonCode', 'basisReferenceKind', 'basisReferenceId'] as const

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export type ValidatedEvent = { ok: true; value: ClosureEventRequest } | { ok: false; code: 'VALIDATION_ERROR'; message: string }

const invalid = (message: string): ValidatedEvent => ({ ok: false, code: 'VALIDATION_ERROR', message })

export function validateClosureEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return invalid('the request body must be an object')
  const fields = body as Record<string, unknown>
  if (!oneOf(closureEventCodes, fields.eventCode)) return invalid('unknown closure event code')
  const unknown = Object.keys(fields).filter((key) => !(KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) return invalid(`unsupported field(s) for ${fields.eventCode}: ${unknown.join(', ')}`)
  const missing = KEYS.filter((key) => !(key in fields))
  if (missing.length > 0) return invalid(`missing field(s): ${missing.join(', ')}`)
  if (!isClosureUuid(fields.resolutionDecisionEventId)) return invalid('invalid resolution decision event id')
  if (!oneOf(closureReasonCodes, fields.closureReasonCode)) return invalid('unknown closure reason code')
  if (!oneOf(basisReferenceKinds, fields.basisReferenceKind)) return invalid('unknown basis reference kind')
  if (!isClosureUuid(fields.basisReferenceId)) return invalid('invalid basis reference id')
  // The reason is the one its basis kind names, and the A8.7 confirmation is its own basis.
  if (fields.closureReasonCode !== REASON_OF_BASIS[fields.basisReferenceKind as BasisReferenceKind]) return invalid(`a ${fields.basisReferenceKind} basis carries the reason ${REASON_OF_BASIS[fields.basisReferenceKind as BasisReferenceKind]}`)
  const sameRecord = fields.basisReferenceId.toLowerCase() === fields.resolutionDecisionEventId.toLowerCase()
  if (fields.basisReferenceKind === 'RESOLUTION_DECISION' ? !sameRecord : sameRecord) return invalid('a RESOLUTION_DECISION basis is the named decision itself; an ESCALATION_RETURN basis is another record')
  return {
    ok: true,
    value: {
      eventCode: 'CONFIRM_INTERNAL_CLOSURE',
      resolutionDecisionEventId: fields.resolutionDecisionEventId.toLowerCase(),
      closureReasonCode: fields.closureReasonCode as ClosureReasonCode,
      basisReferenceKind: fields.basisReferenceKind as BasisReferenceKind,
      basisReferenceId: fields.basisReferenceId.toLowerCase(),
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
