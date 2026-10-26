import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'

// A7.7 §5 — the only request input is the Claim id in the path. A timeline is never filtered, selected or shaped by
// the caller: any query parameter (latestOnly, status, payer, country, a date override, an external id,
// includePayload, …) and any request body are refused rather than ignored.

export const isTimelineUuid = (value: unknown): value is string => isClaimStructureUuid(value)

export function refusedRequestShape(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}; a timeline cannot be filtered or selected`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'a timeline request carries no body'
  return null
}
