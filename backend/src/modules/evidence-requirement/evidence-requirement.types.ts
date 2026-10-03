import type { RuleDecisionProvenanceRefV1 } from '../rule-provenance/rule-provenance.types.ts'

// A5.6 — which governed documentation requirements apply to one exact pre-claim target, and which
// exact evidence versions currently satisfy them.
//
// A3 owns the rule: its identity, applicability, sources, precedence and provenance. An
// EvidenceRequirement is only the typed payload of one DOCUMENTATION_REQUIREMENT_EFFECT RuleVersion —
// which document types it accepts, how many, and how fresh. Completeness is computed read-only on
// every call and never stored: persisting a finding is A5.7/A5.8's, readiness is A5.9's, and freezing
// the evidence a claim used is A6's.

export const DOCUMENTATION_EFFECT = 'DOCUMENTATION_REQUIREMENT_EFFECT'

export type EvidenceRequirementInput = {
  documentTypes: string[]
  minimumCount: number
  sourceDateRequired: boolean
  maxSourceAgeDays: number | null
}

export type EvidenceRequirementDto = {
  id: string
  ruleVersionId: string
  // Ascending, so the same payload always reads back identically. Alternatives, never an order.
  documentTypes: string[]
  minimumCount: number
  sourceDateRequired: boolean
  maxSourceAgeDays: number | null
  createdAt: string
}

export type EncounterEvidenceLinkDto = {
  id: string
  encounterId: string
  evidenceArtifactVersionId: string
  removedAt: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
}

export type EncounterEvidenceLinkListDto = { items: EncounterEvidenceLinkDto[] }

// Why a completeness evaluation could not produce an answer. Upstream A4 and A5.5 failures keep the
// code and reason their owners gave them.
export const completenessReasons = ['REQUIREMENT_RESOLUTION_BLOCKED', 'CONFIGURATION_INCOMPLETE'] as const
export type CompletenessReason = (typeof completenessReasons)[number]

export type EvidenceRequirementErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INTEGRITY_CONFLICT'
  | 'COMMERCIAL_CONTEXT_UNRESOLVED'
  | 'EVIDENCE_REQUIREMENT_UNRESOLVED'

export type EvidenceRequirementResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EvidenceRequirementErrorCode; message: string; reason?: string }

// ---- EvidenceCompletenessEvaluationV1 ---------------------------------------------------------

export type EvidenceCandidateState = 'VALID' | 'INVALID' | 'STALE'
export type RequirementState = 'SATISFIED' | 'MISSING' | 'INCOMPLETE'

export type RequirementCompletenessDto = {
  evidenceRequirementId: string
  ruleVersionId: string
  provenance: RuleDecisionProvenanceRefV1
  acceptedDocumentTypes: string[]
  minimumCount: number
  sourceDateRequired: boolean
  maxSourceAgeDays: number | null
  state: RequirementState
  validCount: number
  invalidCount: number
  staleCount: number
  totalCandidateCount: number
  validEvidenceArtifactVersionIds: string[]
  invalidEvidenceArtifactVersionIds: string[]
  staleEvidenceArtifactVersionIds: string[]
}

export type EvidenceCompletenessEvaluationV1 = {
  schemaVersion: 'EvidenceCompletenessEvaluationV1'
  evaluatedAt: string
  encounterId: string
  encounterActivityId: string | null
  encounterDiagnosisId: string | null
  businessDate: string
  commercialContext: { providerContractId: string; tariffScheduleId: string; tariffScheduleVersionId: string }
  // Ordered by RuleDefinition id: stable, never precedence.
  requirements: RequirementCompletenessDto[]
}
