import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import { EVIDENCE_CONTRACT_OF, evidenceKinds, findingCodes, investigationEventCodes, type EvidenceKind, type InvestigationEventCode, type InvestigationEventRequest } from './exception-investigation.types.ts'

// A8.3 §5 — the request is one event code and exactly that event's own controlled attributes. Any other field (an
// id, actor, membership, tenant, sequence, time, basis code, digest, state, URL, attachment, payload, amount, clinical
// value or narrative) is refused, never ignored. Whether the referenced record exists for this intake, and whether the
// event is a legal next step, is decided later against the owners and the history.

export const isInvestigationUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const KEYS_OF: Record<InvestigationEventCode, readonly string[]> = {
  LINK_EVIDENCE_REFERENCE: ['eventCode', 'evidenceKind', 'evidenceRecordId', 'evidenceContractVersion'],
  RECORD_FINDING: ['eventCode', 'linkedEvidenceEventId', 'findingCode'],
}

export type ValidatedEvent = { ok: true; value: InvestigationEventRequest } | { ok: false; message: string }

export function validateInvestigationEvent(body: unknown): ValidatedEvent {
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be an object' }
  const { eventCode } = body as Record<string, unknown>
  if (typeof eventCode !== 'string' || !(investigationEventCodes as readonly string[]).includes(eventCode)) return { ok: false, message: 'unknown investigation event code' }
  const allowed = KEYS_OF[eventCode as InvestigationEventCode]
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return { ok: false, message: `unsupported field(s) for ${eventCode}: ${unknown.join(', ')}` }
  const missing = allowed.filter((key) => !(key in body))
  if (missing.length > 0) return { ok: false, message: `missing field(s): ${missing.join(', ')}` }
  const fields = body as Record<string, unknown>
  switch (eventCode as InvestigationEventCode) {
    case 'LINK_EVIDENCE_REFERENCE': {
      if (typeof fields.evidenceKind !== 'string' || !(evidenceKinds as readonly string[]).includes(fields.evidenceKind)) return { ok: false, message: 'unknown evidence kind' }
      const kind = fields.evidenceKind as EvidenceKind
      if (!isInvestigationUuid(fields.evidenceRecordId)) return { ok: false, message: 'invalid evidence record id' }
      // Each kind is accepted under exactly one owner contract: an older, newer or another owner's contract is refused.
      if (fields.evidenceContractVersion !== EVIDENCE_CONTRACT_OF[kind]) return { ok: false, message: `evidence of kind ${kind} is accepted only under ${EVIDENCE_CONTRACT_OF[kind]}` }
      return { ok: true, value: { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: kind, evidenceRecordId: fields.evidenceRecordId.toLowerCase(), evidenceContractVersion: EVIDENCE_CONTRACT_OF[kind] } }
    }
    case 'RECORD_FINDING':
      if (!isInvestigationUuid(fields.linkedEvidenceEventId)) return { ok: false, message: 'invalid linked evidence event id' }
      if (typeof fields.findingCode !== 'string' || !(findingCodes as readonly string[]).includes(fields.findingCode)) return { ok: false, message: 'unknown finding code' }
      return { ok: true, value: { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: fields.linkedEvidenceEventId.toLowerCase(), findingCode: fields.findingCode as never } }
  }
}

// The reads take no input but the two path ids: any query parameter or body is refused.
export function refusedReadRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'the read carries no body'
  return null
}
