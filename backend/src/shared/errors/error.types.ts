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
  // A5.9: the exact validation run was produced by a validator version the readiness policy does not
  // accept, so no assessment is recorded for it.
  'READINESS_POLICY_INCOMPATIBLE',
  // A5.9: the assessment exists, but its state is not READY_FOR_REVIEW, so no A6 handoff is produced.
  'PRECLAIM_NOT_READY_FOR_HANDOFF',
  // A5.9: a later validation run exists for the same Encounter, so this assessment no longer
  // describes the Encounter's latest validation and cannot be handed off.
  'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
  // A5.9: another run of the same Encounter has the identical evaluation and creation timestamps, so
  // recency cannot be decided; the system refuses rather than choosing a winner by identifier.
  'VALIDATION_RUN_RECENCY_AMBIGUOUS',
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
