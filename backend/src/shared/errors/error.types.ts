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
  // A6.1: the readiness assessment is RESTRICTED or BLOCKED, so it cannot establish a Claim.
  'PRECLAIM_NOT_READY_FOR_CLAIM',
  // A6.1: the assessment's readiness policy, validator version or handoff contract is not one the
  // A6-CLAIM-1 contract accepts, so no Claim is created.
  'CLAIM_HANDOFF_INCOMPATIBLE',
  // A6.1: a Claim already exists for this readiness assessment; the original is left unchanged.
  'CLAIM_ALREADY_EXISTS',
  // A6.1: the assessment's own Encounter chain does not agree with the Claim being created; the whole
  // transaction is rolled back and nothing is written.
  'CLAIM_BINDING_INTEGRITY_CONFLICT',
  // A6.2: the requested EncounterActivity or EncounterDiagnosis is not in the exact reference set of the
  // Claim's bound PreClaimA6HandoffV1, so it cannot enter the Claim draft.
  'CLAIM_SOURCE_NOT_IN_HANDOFF',
  // A6.2: the requested source row belongs to another Encounter than the Claim's own.
  'CLAIM_SOURCE_ENCOUNTER_MISMATCH',
  // A6.2: another active line of this Claim already carries the same EncounterActivity.
  'CLAIM_LINE_SOURCE_ALREADY_ACTIVE',
  // A6.2: the same EncounterDiagnosis is already active on this Claim.
  'CLAIM_DIAGNOSIS_ALREADY_ACTIVE',
  // A6.2: the target line, diagnosis or pointer has been removed; removed history is never changed.
  'CLAIM_STRUCTURE_INACTIVE',
  // A6.2: a line diagnosis pointer names a ClaimDiagnosis of a different Claim.
  'CLAIM_DIAGNOSIS_POINTER_MISMATCH',
  // A6.2: concurrent changes to the same Claim's structure kept conflicting after bounded retries;
  // nothing was written and the request can be repeated.
  'CLAIM_STRUCTURE_WRITE_CONFLICT',
  // A6.3: a tariff rate can be created or retired only while its tariff version is UNVERIFIED.
  'RATE_VERSION_LOCKED',
  // A6.3: an active rate with the exact same identity already exists in this tariff version.
  'RATE_DUPLICATE',
  // A6.3: the tariff rate has already been retired; a retirement is never repeated or undone.
  'RATE_ALREADY_RETIRED',
  // A6.3: the Claim's bound validation run has no coherent, VERIFIED, provably effective commercial
  // lineage (contract, schedule and version), so nothing can be priced; no current tariff is chosen.
  'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED',
  // A6.3: the Claim's active line structure or a source row is missing, inactive or corrupt.
  'PRICING_SOURCE_INTEGRITY',
  // A6.3: concurrent writes kept conflicting after bounded retries; nothing was written.
  'PRICING_CONFLICT',
  // A6.4: the database refused a claim draft assessment as incoherent (another Claim's pricing run, a
  // different handoff basis or a finding outside the Claim); nothing was written.
  'CLAIM_DRAFT_INTEGRITY_CONFLICT',
  // A6.4: concurrent changes to the Claim kept conflicting with the assessment after bounded retries;
  // nothing was written and the request can be repeated.
  'CLAIM_DRAFT_WRITE_CONFLICT',
  // A6.5: the requested draft assessment is not REVIEWABLE, so it cannot be approved.
  'CLAIM_REVIEW_NOT_REVIEWABLE',
  // A6.5: the request fingerprint is not the assessment's own, or the reviewed draft is no longer current.
  'CLAIM_REVIEW_STALE',
  // A6.5: the reviewer created the Claim or the draft assessment; a separate authorized reviewer must decide.
  'CLAIM_REVIEW_SEPARATION_REQUIRED',
  // A6.5: a second current approval, a return or rejection over a current approval, an invalid revoke target,
  // or concurrent changes that kept conflicting; nothing was written.
  'CLAIM_REVIEW_CONFLICT',
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
