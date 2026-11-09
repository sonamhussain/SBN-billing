import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import {
  type BasisReferenceKind,
  type VerificationCode,
  type VerificationReasonCode,
  type WorkCode,
  type WorkEventCode,
  type WorkEventRequest,
  basisReferenceKinds,
  verificationCodes,
  verificationReasonCodes,
  workCodes,
  workEventCodes,
} from './exception-remediation-work.types.ts'

// A8.6 §3/§5 — the request is one event code and exactly that event's own controlled attributes. Any other field (an
// id, actor, membership, tenant, sequence, time, status, state, outcome, the plan of a verification, the evidence
// contract, text, URL, attachment, payload, amount, clinical value or narrative) is refused, never ignored. An evidence
// kind outside the v1 list is UNSUPPORTED_EVIDENCE_KIND (D3). Whether the plan is the intake's approved one, the work
// code its action's, the cited record an A8.3 event of this intake, and the event a legal next step, is decided later
// against the owners and the history.

export const isWorkUuid = (value: unknown): value is string => isClaimStructureUuid(value)

// A not-verified verification carries its reason; a supported one carries no reason field at all.
const KEYS_OF: Record<WorkEventCode, readonly string[]> = {
  RECORD_WORK_REPORT: ['eventCode', 'approvedProposalEventId', 'workCode', 'basisReferenceKind', 'basisReferenceId'],
  VERIFY_WORK_REPORT: ['eventCode', 'workReportEventId', 'verificationCode'],
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export type ValidatedEvent = { ok: true; value: WorkEventRequest } | { ok: false; code: 'VALIDATION_ERROR' | 'UNSUPPORTED_EVIDENCE_KIND'; message: string }

const invalid = (message: string): ValidatedEvent => ({ ok: false, code: 'VALIDATION_ERROR', message })

export function validateWorkEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return invalid('the request body must be an object')
  const fields = body as Record<string, unknown>
  if (!oneOf(workEventCodes, fields.eventCode)) return invalid('unknown remediation work event code')
  const eventCode = fields.eventCode
  const allowed = eventCode === 'VERIFY_WORK_REPORT' && fields.verificationCode === 'EVIDENCE_NOT_VERIFIED' ? [...KEYS_OF.VERIFY_WORK_REPORT, 'reasonCode'] : KEYS_OF[eventCode]
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return invalid(`unsupported field(s) for ${eventCode}${eventCode === 'VERIFY_WORK_REPORT' ? ` with ${String(fields.verificationCode)}` : ''}: ${unknown.join(', ')}`)
  const missing = allowed.filter((key) => !(key in fields))
  if (missing.length > 0) return invalid(`missing field(s): ${missing.join(', ')}`)
  if (eventCode === 'RECORD_WORK_REPORT') {
    if (!isWorkUuid(fields.approvedProposalEventId)) return invalid('invalid approved proposal event id')
    if (!oneOf(workCodes, fields.workCode)) return invalid('unknown work code')
    if (typeof fields.basisReferenceKind !== 'string') return invalid('invalid evidence kind')
    if (!oneOf(basisReferenceKinds, fields.basisReferenceKind)) return { ok: false, code: 'UNSUPPORTED_EVIDENCE_KIND', message: 'the evidence kind is not supported; a work report cites an A8.3 evidence link or finding of this exception' }
    if (!isWorkUuid(fields.basisReferenceId)) return invalid('invalid evidence record id')
    return {
      ok: true,
      value: {
        eventCode,
        approvedProposalEventId: fields.approvedProposalEventId.toLowerCase(),
        workCode: fields.workCode as WorkCode,
        basisReferenceKind: fields.basisReferenceKind as BasisReferenceKind,
        basisReferenceId: fields.basisReferenceId.toLowerCase(),
      },
    }
  }
  if (!isWorkUuid(fields.workReportEventId)) return invalid('invalid work report event id')
  if (!oneOf(verificationCodes, fields.verificationCode)) return invalid('unknown verification code')
  if (fields.verificationCode === 'EVIDENCE_NOT_VERIFIED' && !oneOf(verificationReasonCodes, fields.reasonCode)) return invalid('a not-verified verification carries a controlled reason code')
  return {
    ok: true,
    value: {
      eventCode,
      workReportEventId: fields.workReportEventId.toLowerCase(),
      verificationCode: fields.verificationCode as VerificationCode,
      reasonCode: fields.verificationCode === 'EVIDENCE_NOT_VERIFIED' ? (fields.reasonCode as VerificationReasonCode) : null,
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
