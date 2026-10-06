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
