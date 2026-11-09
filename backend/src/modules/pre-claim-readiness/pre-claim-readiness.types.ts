// A5.9 — one immutable pre-claim readiness assessment for one exact A5.7 ValidationRun, and the
// read-only PreClaimA6HandoffV1 reference contract derived from it.
//
// A5.9 composes; it never validates. The state is a deterministic reduction of the run's immutable
// finding outcomes under a named readiness policy. READY_FOR_REVIEW means human claim review may begin —
// it is not submission approval, payer acceptance or a claim status. A6 owns Claim, ClaimLine,
// ClaimSubmission, pricing and human approval; A5.9 creates none of them.

export const READINESS_POLICY_VERSION = 'A5-READY-1'

export const readinessStates = ['READY_FOR_REVIEW', 'RESTRICTED', 'BLOCKED'] as const
export type ReadinessState = (typeof readinessStates)[number]

export const HANDOFF_SCHEMA_VERSION = 'PreClaimA6HandoffV1'

export type ReadinessAssessmentDto = {
  id: string
  validationRunId: string
  readinessPolicyVersion: string
  state: string
  assessedAt: string
  createdByUserId: string
  createdAt: string
}

export type ReadinessAssessmentListDto = { items: ReadinessAssessmentDto[] }

// §9 — a reason is an exact finding id with its stable code, in the run's sequence order. Reasons are
// derived from the immutable findings at read time; message text is never a reason.
export type ReadinessReasonRef = { findingId: string; sequence: number; findingCode: string }

export type ReadinessAssessmentDetailDto = ReadinessAssessmentDto & {
  reasons: {
    blockedFindings: ReadinessReasonRef[]
    restrictedFindings: ReadinessReasonRef[]
    warningFindings: ReadinessReasonRef[]
    passFindings: ReadinessReasonRef[]
  }
}

// §12 — references only. Every id array is exact, deduplicated and sorted ascending; the order is
// never precedence. No patient or member value, evidence metadata, price, Claim id or approval.
export type PreClaimA6HandoffV1 = {
  schemaVersion: 'PreClaimA6HandoffV1'
  readinessAssessmentId: string
  readinessPolicyVersion: 'A5-READY-1'
  readinessState: 'READY_FOR_REVIEW'
  assessedAt: string
  validationRun: {
    id: string
    validatorVersion: 'A5-VAL-1'
    evaluatedAt: string
    encounterId: string
    context: {
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
  }
  findingSummary: { total: number; pass: number; warning: number; restrict: number; fail: number }
  findingRefs: { id: string; sequence: number; layer: string; outcome: string; findingCode: string }[]
  exactReferences: {
    encounterActivityIds: string[]
    encounterDiagnosisIds: string[]
    eligibilityVerificationIds: string[]
    priorAuthorizationVersionIds: string[]
    authorizationLineIds: string[]
    evidenceRequirementIds: string[]
    evidenceArtifactVersionIds: string[]
    ruleVersionIds: string[]
    governingSourceVersionIds: string[]
    referenceDatasetVersionIds: string[]
  }
}

// CRG-01 Checkpoint B — PreClaimA6HandoffV2: every PreClaimA6HandoffV1 field under A5-READY-2 over A5-VAL-2, plus the
// run's coding receipts verified as recorded. PreClaimA6HandoffV1 is unchanged and still the answer for a V1 assessment.
export const READINESS_POLICY_VERSION_V2 = 'A5-READY-2'
export const HANDOFF_SCHEMA_VERSION_V2 = 'PreClaimA6HandoffV2'
// The handoff contracts A6 accepts, each through its own version-specific branch.
export const ACCEPTED_HANDOFF_SCHEMA_VERSIONS: readonly string[] = [HANDOFF_SCHEMA_VERSION, HANDOFF_SCHEMA_VERSION_V2]
export const isAcceptedHandoffSchema = (version: string) => ACCEPTED_HANDOFF_SCHEMA_VERSIONS.includes(version)

export type HandoffCodingReceiptsV2 = {
  manifestId: string
  manifestSha256: string
  receiptCount: number
  receipts: { receiptId: string; subjectKind: string; targetId: string; findingId: string; decisionCode: string; codeSystemDatasetId: string | null; referenceDatasetVersionId: string | null; membershipId: string | null }[]
}

export type PreClaimA6HandoffV2 = Omit<PreClaimA6HandoffV1, 'schemaVersion' | 'readinessPolicyVersion' | 'validationRun'> & {
  schemaVersion: 'PreClaimA6HandoffV2'
  readinessPolicyVersion: 'A5-READY-2'
  validationRun: Omit<PreClaimA6HandoffV1['validationRun'], 'validatorVersion'> & { validatorVersion: 'A5-VAL-2' }
  codingReceipts: HandoffCodingReceiptsV2
}

export type PreClaimA6Handoff = PreClaimA6HandoffV1 | PreClaimA6HandoffV2

export type PreClaimReadinessErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTEGRITY_CONFLICT'
  | 'READINESS_POLICY_INCOMPATIBLE'
  | 'PRECLAIM_NOT_READY_FOR_HANDOFF'
  | 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION'
  | 'VALIDATION_RUN_RECENCY_AMBIGUOUS'

export type PreClaimReadinessResult<T> = { ok: true; value: T } | { ok: false; code: PreClaimReadinessErrorCode; message: string }
