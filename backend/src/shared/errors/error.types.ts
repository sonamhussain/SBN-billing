export const apiErrorCodes = [
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const

export type ApiErrorCode = (typeof apiErrorCodes)[number]

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode
    message: string
    requestId: string
  }
}
