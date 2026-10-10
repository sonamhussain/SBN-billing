// A6.1 — the stable internal Claim identity (A6-CLAIM-1), bound forever to one exact READY_FOR_REVIEW
// readiness assessment through the PreClaimA6HandoffV1 contract.
//
// A Claim is not a submission. It carries no line, money, lifecycle state, approval, payload or
// transport field; A6.2-A6.9 and A9 own those. Organization, payer, facility, regulatory profile,
// validation run and readiness state are never stored here: they are reached through the bound A5 chain.

export const CLAIM_CONTRACT_VERSION = 'A6-CLAIM-1'

// §5 — the stored identity, exactly as the create response returns it.
export type ClaimDto = {
  id: string
  encounterId: string
  preClaimReadinessAssessmentId: string
  claimContractVersion: string
  handoffSchemaVersion: string
  createdByUserId: string
  createdAt: string
}

// §10 — reads add source-binding metadata derived from the bound immutable assessment at read time,
// for navigation. It is never persisted on the Claim and never a lifecycle status.
export type ClaimReadDto = ClaimDto & {
  source: { validationRunId: string; readinessState: string }
}

// History order (createdAt DESC, then id ASC) — never a current, primary or winning Claim.
export type ClaimListDto = { items: ClaimReadDto[] }

export type ClaimErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'PRECLAIM_NOT_READY_FOR_CLAIM'
  | 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION'
  | 'VALIDATION_RUN_RECENCY_AMBIGUOUS'
  | 'CLAIM_HANDOFF_INCOMPATIBLE'
  | 'CLAIM_ALREADY_EXISTS'
  | 'CLAIM_BINDING_INTEGRITY_CONFLICT'

export type ClaimResult<T> = { ok: true; value: T } | { ok: false; code: ClaimErrorCode; message: string }
