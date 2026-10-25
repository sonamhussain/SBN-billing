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
  // A6.6: the canonical payload needs the current human approval of exactly this assessment.
  'CLAIM_PAYLOAD_NOT_AUTHORIZED',
  // A6.6: the handoff, reviewed draft or approval is no longer current; nothing was composed.
  'CLAIM_PAYLOAD_STALE',
  // A6.6: a required field of the canonical payload is absent or not frozen; nothing was composed.
  'CLAIM_PAYLOAD_INCOMPLETE',
  // A6.6: a required interpretation (such as a currency scale) is not defined; nothing was composed.
  'CLAIM_PAYLOAD_UNSUPPORTED',
  // A6.7: no exact current human APPROVE of this assessment (returned, rejected, revoked or superseded).
  'CLAIM_SUBMISSION_NOT_APPROVED',
  // A6.7: the Claim, pricing, sources, readiness, draft or fingerprint changed since the approval.
  'CLAIM_SUBMISSION_STALE',
  // A6.7: an exact required historical evidence or provenance reference cannot be referenced; nothing frozen.
  'CLAIM_SUBMISSION_EVIDENCE_INCOMPLETE',
  // A6.7: the approval was reused inconsistently, concurrency kept conflicting, or an integrity contradiction.
  'CLAIM_SUBMISSION_CONFLICT',
  // A6.7: a required schema or interpretation is not implemented; nothing was frozen.
  'CLAIM_SUBMISSION_UNSUPPORTED',
  // A6.8: the lifecycle event is not an allowed A6-LIFECYCLE-1 edge from the current internal disposition
  // (including a duplicate and anything after WITHDRAWN_INTERNAL); nothing was recorded.
  'CLAIM_LIFECYCLE_TRANSITION_NOT_ALLOWED',
  // A6.8: concurrent decisions kept conflicting, the history cannot be trusted, the database refused the
  // event, or the outcome could not be established; nothing (further) was recorded.
  'CLAIM_LIFECYCLE_CONFLICT',
  // A6.9: the correction link is not allowed (fork, join, cycle, chronology, same draft assessment, a second
  // chain, or a recorded pair with another reason); nothing was linked.
  'CLAIM_CORRECTION_NOT_ALLOWED',
  // A6.9: concurrent decisions kept conflicting, a history or freeze cannot be trusted, the database refused
  // the link, or the outcome could not be established; nothing (further) was linked.
  'CLAIM_CORRECTION_CONFLICT',
  // A7.1: concurrent registrations kept conflicting, the frozen submission cannot be trusted, the database
  // refused the registration, or the outcome could not be established; nothing (further) was registered.
  'REVENUE_EVIDENCE_CONFLICT',
  // A7.2: a claim of external verification without an authenticated source proof; nothing was classified.
  'EVIDENCE_CLASSIFICATION_NOT_ALLOWED',
  // A7.2: a recorded classification disagrees with its re-derivation, concurrent classifications kept
  // conflicting, the database refused the classification, or the outcome could not be established; nothing
  // (further) was classified.
  'EVIDENCE_CLASSIFICATION_CONFLICT',
  // A7.3: the classification, its source and their organization do not link exactly, an owner could not confirm
  // them, the classification is not a controlled result, or a recorded readiness disagrees with its derivation;
  // nothing was recorded.
  'ADJUDICATION_READINESS_PROVENANCE_CONFLICT',
  // A7.3: concurrent requests kept conflicting, the claim stayed busy, or the outcome could not be established;
  // nothing (further) was recorded.
  'ADJUDICATION_READINESS_CONFLICT',
  // A7.4: the frozen submission, a source, classification or readiness result is broken, contradictory or
  // ambiguous, or the database refused the case at insert or commit; nothing was recorded.
  'REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT',
  // A7.4: concurrent requests kept conflicting, the claim stayed busy, or the outcome could not be established;
  // nothing (further) was recorded.
  'REVENUE_EVIDENCE_CASE_CONFLICT',
  // A7.5: the case snapshot, a linked readiness result or the organization is broken or contradictory, a recorded
  // assessment disagrees with its derivation, or the database refused the assessment; nothing was recorded.
  'EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT',
  // A7.5: concurrent requests kept conflicting, the claim stayed busy, or the outcome could not be established;
  // nothing (further) was recorded.
  'EVIDENCE_CASE_PREREQUISITE_CONFLICT',
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
