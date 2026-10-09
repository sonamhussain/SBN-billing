// FE-04 — the A5.6 EvidenceCompletenessEvaluationV1 read: for the Encounter (or one of its activities or
// diagnoses), each governed evidence requirement with its own state and candidate counts. It is a
// read-only evaluation, not a validation finding: SATISFIED / MISSING / INCOMPLETE are never rewritten
// as PASS / FAIL.
export type RequirementState = 'SATISFIED' | 'MISSING' | 'INCOMPLETE'

export type RequirementCompleteness = {
  evidenceRequirementId: string
  ruleVersionId: string
  acceptedDocumentTypes: string[]
  minimumCount: number
  sourceDateRequired: boolean
  maxSourceAgeDays: number | null
  state: RequirementState
  validCount: number
  invalidCount: number
  staleCount: number
  totalCandidateCount: number
}

export type EvidenceCompletenessEvaluation = {
  schemaVersion: 'EvidenceCompletenessEvaluationV1'
  evaluatedAt: string
  encounterId: string
  encounterActivityId: string | null
  encounterDiagnosisId: string | null
  businessDate: string
  requirements: RequirementCompleteness[]
}

// The optional target. Both null means the Encounter itself.
export type CompletenessTarget = { encounterActivityId?: string; encounterDiagnosisId?: string }
