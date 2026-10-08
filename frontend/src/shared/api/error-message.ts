import { ApiClientError } from './client.ts'

// FE-02 — what a form may say about a failed request. A 400 carries the backend's validation message,
// which names fields and limits but never echoes submitted values. 403/404 never reveal whether a
// record exists in another organization. The requestId lets support trace the request.
export function describeSaveError(error: unknown, subject: string) {
  if (!(error instanceof ApiClientError)) return `${subject} could not be saved. Check the connection and try again.`
  const reference = error.requestId ? ` Request ID: ${error.requestId}` : ''
  if (error.status === 400) return `${subject} could not be saved: ${error.message}.${reference}`
  if (error.status === 403) return `This action is not available to you.${reference}`
  if (error.status === 404) return `This record is unavailable.${reference}`
  return `${subject} could not be saved.${reference}`
}

// FE-04 — what a read or an explicit evaluation (commercial context, completeness, scope, handoff) may say
// when the backend refuses. 403/404 stay privacy-safe. A 400 or 409 carries the backend's own safe message
// and, when present, its machine-readable code/reason, so an unresolved or ambiguous state is shown as the
// backend stated it — never replaced by a guess.
export function describeApiFailure(error: unknown, subject: string) {
  if (!(error instanceof ApiClientError)) return `${subject} could not be loaded. Check the connection and try again.`
  const reference = error.requestId ? ` Request ID: ${error.requestId}` : ''
  if (error.status === 403) return `${subject} is not available to you.${reference}`
  if (error.status === 404) return `${subject} is unavailable.${reference}`
  if (error.status === 400 || error.status === 409) {
    const detail = error.reason ? `${error.code} — ${error.reason}` : error.code
    return `${subject}: ${error.message} (${detail}).${reference}`
  }
  return `${subject} could not be loaded.${reference}`
}
