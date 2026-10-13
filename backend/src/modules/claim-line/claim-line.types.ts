// A6.2 — ClaimLine answers one question: which exact validated EncounterActivity is carried into this
// Claim draft, at which Claim-specific position, and which of the Claim's diagnoses it points to. It
// does not price the line, decide completeness, approve, serialize or submit anything.
//
// Service, procedure, quantity, unit and modifiers are never stored on a ClaimLine. A read derives them
// from the exact source EncounterActivity at read time, so the line can never contradict A4.6.

export const CLAIM_LINE_CONTRACT_VERSION = 'A6-LINE-1'

// Positions are rewritten in two phases (park far outside the live range, then write the final
// position), so the active (claim_id, sequence) unique index is never disabled during a reorder.
export const SEQUENCE_PARKING_OFFSET = 1_000_000

// §9 — the derived source facts of a line, read through the owner join; never persisted on the line.
export type ClaimLineSourceDto = {
  encounterActivityId: string
  serviceId: string | null
  procedureCodeId: string | null
  // Canonical decimal string (never a JavaScript binary float).
  quantity: string
  unitCode: string | null
  // In stored modifier order.
  modifierCodes: string[]
}

export type ClaimLineDto = {
  id: string
  claimId: string
  sequence: number
  claimLineContractVersion: string
  removedAt: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
  source: ClaimLineSourceDto
  // §11 — the ACTIVE ClaimDiagnosis ids this line points to, in ClaimDiagnosis.sequence order. There is
  // no pointer-order column; the order is derived.
  claimDiagnosisIds: string[]
}

export type ClaimLineListDto = { items: ClaimLineDto[] }

// §13 — every refusal an A6.2 structure write can produce. NOT_FOUND is 404, VALIDATION_ERROR is 400 and
// every other code is 409.
export type ClaimStructureErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTEGRITY_CONFLICT'
  | 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION'
  | 'VALIDATION_RUN_RECENCY_AMBIGUOUS'
  | 'CLAIM_HANDOFF_INCOMPATIBLE'
  | 'CLAIM_BINDING_INTEGRITY_CONFLICT'
  | 'CLAIM_SOURCE_NOT_IN_HANDOFF'
  | 'CLAIM_SOURCE_ENCOUNTER_MISMATCH'
  | 'CLAIM_LINE_SOURCE_ALREADY_ACTIVE'
  | 'CLAIM_DIAGNOSIS_ALREADY_ACTIVE'
  | 'CLAIM_STRUCTURE_INACTIVE'
  | 'CLAIM_DIAGNOSIS_POINTER_MISMATCH'
  | 'CLAIM_STRUCTURE_WRITE_CONFLICT'

export type ClaimStructureResult<T> = { ok: true; value: T } | { ok: false; code: ClaimStructureErrorCode; message: string }

// §12 BODY OWNERSHIP — the only fields a client may supply. Everything else is server-owned.
export const createLineBodyFields = ['encounterActivityId'] as const
export const orderLineBodyFields = ['claimLineIds'] as const
export const pointerBodyFields = ['claimDiagnosisIds'] as const
// Named explicitly so a forged value is reported as server-owned rather than merely unknown.
export const serverOwnedLineFields = [
  'id',
  'claimId',
  'encounterId',
  'sequence',
  'claimLineContractVersion',
  'removedAt',
  'createdByUserId',
  'createdAt',
  'updatedAt',
] as const
