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
  // A5.5: the request and the stored data are both sound, but the commercial context does not
  // resolve to exactly one contract and one verified tariff version. A `reason` names which.
  'COMMERCIAL_CONTEXT_UNRESOLVED',
  // A5.6: the context is sound, but governed evidence requirements could not be resolved — an
  // applicable documentation rule is blocked in A3, or is VERIFIED without its typed payload. A
  // `reason` names which.
  'EVIDENCE_REQUIREMENT_UNRESOLVED',
] as const

export type ApiErrorCode = (typeof apiErrorCodes)[number]

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode
    message: string
    requestId: string
    // A5.5: an optional machine-readable refinement of `code`, present only when a module supplies
    // one. Every other error keeps the original three-field shape.
    reason?: string
  }
}
