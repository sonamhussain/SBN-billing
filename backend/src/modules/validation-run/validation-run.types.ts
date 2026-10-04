// A5.7 — the immutable persistence foundation for one pre-claim ValidationRun and its ordered
// ValidationFindings.
//
// A5.7 stores results; it does not execute validation. Which checks run, what a finding code means and
// how governed provenance is built are A5.8's. Composing readiness is A5.9's. Claim lifecycle state is
// A6's. A run is a complete atomic snapshot recorded by an internal, transaction-aware recorder — there
// is no public create or execute route, no status, no current/latest pointer and no overall outcome.

export const validationLayers = ['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE'] as const
export type ValidationLayer = (typeof validationLayers)[number]

export const validationOutcomes = ['PASS', 'WARNING', 'RESTRICT', 'FAIL'] as const
export type ValidationOutcome = (typeof validationOutcomes)[number]

// A stable machine-readable token. Downstream consumes this and the outcome; it never parses message.
export const FINDING_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/

export const MAX_VALIDATOR_VERSION_LENGTH = 96
export const MAX_MESSAGE_LENGTH = 512
export const MAX_FIELD_PATH_LENGTH = 256
// §22 — a synthetic safety cap on one run's finding set.
export const MAX_FINDINGS = 1000

// The exact server-owned context the validator evaluated. Every key must be present; the membership
// and commercial ones may be null when they were absent or unresolved, and null never means "valid".
export const contextIdFields = [
  'facilityId',
  'facilityRegulatoryProfileId',
  'insuranceMembershipId',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'providerContractId',
  'tariffScheduleId',
  'tariffScheduleVersionId',
] as const
export type ContextIdField = (typeof contextIdFields)[number]
export const requiredContextIdFields: readonly ContextIdField[] = ['facilityId', 'facilityRegulatoryProfileId']

export type ValidationRunContextSnapshot = {
  serviceDate: string
  facilityId: string
  facilityRegulatoryProfileId: string
  insuranceMembershipId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
}

// Minimum exact provenance. A5.8 selects these ids; A5.7 never chooses a "latest" version itself.
export const provenanceFields = ['ruleVersionId', 'governingSourceVersionId', 'referenceDatasetVersionId'] as const
export type ProvenanceField = (typeof provenanceFields)[number]

// Existing pre-claim objects a finding may concern. There is deliberately no claimLineId.
export const targetFields = [
  'encounterActivityId',
  'encounterDiagnosisId',
  'eligibilityVerificationId',
  'priorAuthorizationVersionId',
  'authorizationLineId',
  'evidenceRequirementId',
  'evidenceArtifactVersionId',
] as const
export type TargetField = (typeof targetFields)[number]

export type ValidationFindingDraft = {
  layer: ValidationLayer
  outcome: ValidationOutcome
  findingCode: string
  fieldPath: string | null
  message: string
} & Record<ProvenanceField | TargetField, string | null>

export type ValidationRunDraft = {
  encounterId: string
  contextSnapshot: ValidationRunContextSnapshot
  validatorVersion: string
  findings: ValidationFindingDraft[]
}

export type ValidationRunDto = {
  id: string
  encounterId: string
  evaluatedAt: string
  validatorVersion: string
  createdByUserId: string
  createdAt: string
  context: ValidationRunContextSnapshot
  findingCount: number
}

export type ValidationRunListDto = { items: ValidationRunDto[] }

export type ValidationFindingDto = {
  id: string
  validationRunId: string
  sequence: number
  layer: string
  outcome: string
  findingCode: string
  fieldPath: string | null
  message: string
  provenance: Record<ProvenanceField, string | null>
  targets: Record<TargetField, string | null>
  // A5.8 §21 — the exact normalized A3-PROV-1 basis of a governed finding; null for a system finding,
  // whose execution provenance is the run's validatorVersion. Id sets are ascending.
  ruleProvenance: {
    provenanceContractVersion: string
    precedencePolicyVersion: string
    rulePackVersionId: string | null
    governingBindingId: string
    governingSourceInterpretationId: string
    businessDate: string
    evaluationTimestamp: string
    historicalOnly: boolean
    supportingBindingIds: string[]
    matchedApplicabilityIds: string[]
    referenceDatasetVersionIds: string[]
  } | null
  createdAt: string
}

export type ValidationFindingListDto = { items: ValidationFindingDto[] }

export type ValidationRunErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type ValidationRunResult<T> = { ok: true; value: T } | { ok: false; code: ValidationRunErrorCode; message: string }
