import type { RuleDecisionProvenanceRefV1 } from '../rule-provenance/rule-provenance.types.ts'
import type { ValidationFindingDraft, ValidationLayer, ValidationOutcome, ValidationRunContextSnapshot } from '../validation-run/validation-run.types.ts'

// A5.8 — Layered Deterministic Pre-Claim Validation & Provenance.
//
// One execution reads the authoritative A4 and A5.1–A5.6 facts of one Encounter inside ONE REPEATABLE
// READ write transaction, produces the A5-VAL-1 findings across the five layers, and records one
// immutable A5.7 ValidationRun with normalized A3-PROV-1 provenance for every governed finding. It
// composes no readiness, computes no price and creates no claim state.

// §3 — the validator contract. Changing a check, a findingCode meaning or an outcome mapping requires a
// new version; historical runs are never reinterpreted.
export const VALIDATOR_VERSION = 'A5-VAL-1'

// One finding the validator produced, before A5.7 records it. A governed finding carries the exact
// A3-PROV-1 decision basis it was produced under; a system-invariant finding carries none.
export type FindingDraft = ValidationFindingDraft & { provenance: RuleDecisionProvenanceRefV1 | null }

export type CatalogEntry = { layer: ValidationLayer; outcome: ValidationOutcome; message: string }

export type ExecutionContext = ValidationRunContextSnapshot

export type PreClaimValidationExecutionDto = {
  validationRunId: string
  evaluatedAt: string
  validatorVersion: typeof VALIDATOR_VERSION
  findingCount: number
}

export type PreClaimValidationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTEGRITY_CONFLICT'

export type PreClaimValidationResult<T> = { ok: true; value: T } | { ok: false; code: PreClaimValidationErrorCode; message: string }

// An upstream integrity defect or a recorder/provenance refusal. It is not a validation outcome: it
// aborts the transaction, so no partial run is ever committed, and the route answers with a safe 409.
export class ValidationIntegrityDefect extends Error {}
