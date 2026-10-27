import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'

// A7.8 §5 — the only request input is the Claim id in the path. A delta is never filtered, selected or shaped by the
// caller: any query parameter (latest, current, payer, amount, override, a source list, an actor, …) and any request
// body are refused rather than ignored.

export const isDeltaUuid = (value: unknown): value is string => isClaimStructureUuid(value)

export function refusedDeltaRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}; a delta cannot be filtered or selected`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'a delta request carries no body'
  return null
}
