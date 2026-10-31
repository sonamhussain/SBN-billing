import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import { SOURCE_CONTRACT_OF, exceptionReasonCodes, sourceKinds, type IntakeRequest, type SourceKind } from './exception-intake.types.ts'

// A8.1 §5 — the request is exactly four fields. Any other field (an id, identityKey, organization, Claim, actor,
// time, status, contextCode, amount, payload, description, narrative or resolution) is refused, never ignored. The
// source contract must be exactly the one its kind is accepted under (a version fence); the reason must be a
// controlled code. Whether the reason is TRUE is decided only later, by the source's own owner.

export const isIntakeUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const REQUEST_KEYS = ['sourceKind', 'sourceRecordId', 'sourceContractVersion', 'exceptionReasonCode']

export type ValidatedRequest = { ok: true; value: IntakeRequest } | { ok: false; message: string }

export function validateIntakeRequest(body: unknown): ValidatedRequest {
  if (!isPlainObject(body)) return { ok: false, message: 'the request body must be an object' }
  const unknown = Object.keys(body).filter((key) => !REQUEST_KEYS.includes(key))
  if (unknown.length > 0) return { ok: false, message: `unsupported field(s): ${unknown.join(', ')}` }
  const missing = REQUEST_KEYS.filter((key) => !(key in body))
  if (missing.length > 0) return { ok: false, message: `missing field(s): ${missing.join(', ')}` }
  const { sourceKind, sourceRecordId, sourceContractVersion, exceptionReasonCode } = body as Record<string, unknown>
  if (typeof sourceKind !== 'string' || !(sourceKinds as readonly string[]).includes(sourceKind)) return { ok: false, message: 'unknown source kind' }
  if (!isIntakeUuid(sourceRecordId)) return { ok: false, message: 'invalid source record id' }
  if (sourceContractVersion !== SOURCE_CONTRACT_OF[sourceKind as SourceKind]) return { ok: false, message: 'unsupported source contract version for this source kind' }
  if (typeof exceptionReasonCode !== 'string' || !(exceptionReasonCodes as readonly string[]).includes(exceptionReasonCode)) return { ok: false, message: 'unknown exception reason' }
  return {
    ok: true,
    value: { sourceKind: sourceKind as SourceKind, sourceRecordId: sourceRecordId.toLowerCase(), sourceContractVersion, exceptionReasonCode: exceptionReasonCode as IntakeRequest['exceptionReasonCode'] },
  }
}

// The read takes no input but the Claim id: any query parameter or body is refused.
export function refusedListRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'the read carries no body'
  return null
}
