// A6.6 — the canonical claim payload answers one question: what are the exact, approved facts of ONE Claim,
// for ONE A6.4 draft assessment and ONE A6.5 APPROVE decision, written as one versioned internal SBN
// representation that always encodes to the same UTF-8 bytes?
//
// It is an internal representation only: not an insurer claim, not a DHPO/eClaimLink or X12 message, not an
// HIE record and not a submission. A6.6 composes it read-only; the SHA-256 it returns over the bytes is a
// comparison aid, never the immutable submission hash. A6.7 owns freezing it inside its own guarded write
// transaction; A9 adapters own any destination mapping.

export const PAYLOAD_SCHEMA_VERSION = 'A6-PAYLOAD-1'

// §3 — the A6-PAYLOAD-1 shape. Identifiers only for every master or clinical reference (code text can be
// edited on its master and is never copied). Every decimal is an exact string: quantities and unit tariff
// rates at the A6.3 storage scale of 4 decimals, money at the currency's minor units. Nullable fields are
// explicit nulls; no field is ever omitted.

export type CanonicalHeaderV1 = {
  claimId: string
  claimContractVersion: string
  handoffSchemaVersion: string
  encounterId: string
  serviceDate: string
  facilityId: string
  facilityRegulatoryProfileId: string
  jurisdictionCode: string
  assessedValidationRunId: string
  readinessAssessmentId: string
  readinessPolicyVersion: string
  draftAssessmentId: string
  draftContractVersion: string
  draftFingerprint: string
  pricingRunId: string
  pricingContractVersion: string
  approvalDecisionId: string
}

export type CanonicalCommercialV1 = {
  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  currencyCode: string
}

export type CanonicalLineV1 = {
  claimLineId: string
  sequence: number
  encounterActivityId: string
  serviceId: string | null
  procedureCodeId: string | null
  quantity: string
  unitCode: string | null
  modifierCodes: string[]
  pricingLineResultId: string
  tariffRateId: string
  unitTariffAmount: string
  extendedAmount: string
  currencyCode: string
  // Active ClaimDiagnosis ids this line points to, in ClaimDiagnosis.sequence order.
  claimDiagnosisIds: string[]
}

export type CanonicalDiagnosisV1 = {
  claimDiagnosisId: string
  sequence: number
  encounterDiagnosisId: string
  roleCode: string
  diagnosisCodeId: string
}

export type CanonicalFinancialV1 = {
  // The one exact A6.3 priced total: an extended tariff charge only — no insurer net, tax, discount or
  // patient share.
  totalExtendedAmount: string
  currencyCode: string
}

// The approved A5.9 handoff references, each set intrinsically unordered: sorted ascending and deduplicated.
// The order never expresses precedence.
export type CanonicalEvidenceV1 = {
  validationFindingIds: string[]
  eligibilityVerificationIds: string[]
  priorAuthorizationVersionIds: string[]
  authorizationLineIds: string[]
  evidenceRequirementIds: string[]
  evidenceArtifactVersionIds: string[]
  ruleVersionIds: string[]
  governingSourceVersionIds: string[]
  referenceDatasetVersionIds: string[]
}

export type CanonicalApprovalV1 = {
  reviewContractVersion: string
  decisionId: string
  reviewedAssessmentId: string
  reviewFingerprint: string
  reviewerUserId: string
}

export type CanonicalClaimPayloadV1 = {
  schemaVersion: typeof PAYLOAD_SCHEMA_VERSION
  header: CanonicalHeaderV1
  commercial: CanonicalCommercialV1
  lines: CanonicalLineV1[]
  diagnoses: CanonicalDiagnosisV1[]
  financial: CanonicalFinancialV1
  evidence: CanonicalEvidenceV1
  approval: CanonicalApprovalV1
}

// §5 — the typed outcome. Only COMPOSED carries a payload and bytes.
export const payloadFailureOutcomes = ['NOT_AUTHORIZED', 'STALE', 'INCOMPLETE', 'UNSUPPORTED', 'INTEGRITY_CONFLICT'] as const
export type PayloadFailureOutcome = (typeof payloadFailureOutcomes)[number]

export type ComposedPayload = {
  outcome: 'COMPOSED'
  organizationId: string
  payload: CanonicalClaimPayloadV1
  bytes: Buffer
  sha256: string
}

export type ComposeResult =
  | ({ ok: true } & ComposedPayload)
  | { ok: false; outcome: PayloadFailureOutcome | 'NOT_FOUND' | 'VALIDATION_ERROR'; message: string }

// §8 — the read-only preview: the canonical view, its schema version, the byte length and a SHA-256 of the
// canonical bytes that is explicitly a preview comparison aid, not a submission hash. The bytes themselves
// are never returned.
export type CanonicalPayloadPreviewDto = {
  schemaVersion: typeof PAYLOAD_SCHEMA_VERSION
  previewDigestSha256: string
  byteLength: number
  payload: CanonicalClaimPayloadV1
}

export type ClaimPayloadErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CLAIM_PAYLOAD_NOT_AUTHORIZED'
  | 'CLAIM_PAYLOAD_STALE'
  | 'CLAIM_PAYLOAD_INCOMPLETE'
  | 'CLAIM_PAYLOAD_UNSUPPORTED'
  | 'INTEGRITY_CONFLICT'

export type ClaimPayloadResult<T> = { ok: true; value: T } | { ok: false; code: ClaimPayloadErrorCode; message: string }
