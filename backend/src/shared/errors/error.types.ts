export const apiErrorCodes = [
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  // A4.5: stored state breaks a domain invariant (e.g. active diagnosis order is not 1..N). The
  // conflict is in the data, not the request; it is refused, never silently repaired.
  'INTEGRITY_CONFLICT',
] as const

export type ApiErrorCode = (typeof apiErrorCodes)[number]

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode
    message: string
    requestId: string
  }
}
