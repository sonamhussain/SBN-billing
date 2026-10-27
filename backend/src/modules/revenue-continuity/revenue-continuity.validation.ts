import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'

// A7.9 §5 — the only request input is the Claim id in the path. A continuity result is never filtered, selected or
// shaped by the caller: any query parameter (latestOnly, date, payer, actor, tenant, overriding evidence, a source
// list, …) and any request body are refused rather than ignored.

export const isContinuityUuid = (value: unknown): value is string => isClaimStructureUuid(value)

export function refusedContinuityRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}; a continuity result cannot be filtered or selected`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'a continuity request carries no body'
  return null
}
