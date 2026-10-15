import type { ClaimStructureErrorCode } from '../claim-line/claim-line.types.ts'

// A6.4 — a claim draft assessment answers one question: is this Claim's exact draft (its bound A5
// handoff, its active A6.2 lines, diagnoses and pointers, and one exact A6.3 pricing run named by the
// caller) internally complete, coherent and current enough to be put in front of a human reviewer?
//
// REVIEWABLE is a candidate for human review, never approval, sign-off, submission authority or a
// Claim lifecycle state. A6.4 never re-runs the A5 validator, never chooses a tariff or a "latest"
// pricing run and never recalculates money; it composes the owners' stored facts and compares them.

export const DRAFT_CONTRACT_VERSION = 'A6-DRAFT-1'

// §3 — the reduced outcome. Precedence when several findings exist: INVALID > STALE > INCOMPLETE >
// REVIEWABLE. Every finding is kept whatever the reduced outcome is.
export const draftOutcomes = ['REVIEWABLE', 'INCOMPLETE', 'STALE', 'INVALID'] as const
export type DraftOutcome = (typeof draftOutcomes)[number]

// The classification a finding contributes to the reduced outcome. ADVISORY findings never reduce it.
export type FindingClass = 'INVALID' | 'STALE' | 'INCOMPLETE' | 'ADVISORY'

export const findingSeverities = ['BLOCKER', 'ADVISORY'] as const
export type FindingSeverity = (typeof findingSeverities)[number]

// §6 — the fixed owner vocabulary: which owner's facts a finding is about.
export const ownerScopes = ['CLAIM', 'HANDOFF', 'LINE', 'DIAGNOSIS', 'POINTER', 'PRICING', 'COMMERCIAL', 'SOURCE', 'JURISDICTION'] as const
export type OwnerScope = (typeof ownerScopes)[number]

// §8 — the finding catalogue, in evaluation (and therefore presentation) order. Each code has one fixed
// classification and owner scope; nothing is decided by free text.
export const findingCatalogue = {
  CLAIM_DRAFT_HANDOFF_INVALID: { class: 'INVALID', scope: 'HANDOFF' },
  CLAIM_DRAFT_NO_LINES: { class: 'INCOMPLETE', scope: 'LINE' },
  CLAIM_DRAFT_ORDER_CORRUPT: { class: 'INVALID', scope: 'CLAIM' },
  CLAIM_DRAFT_LINE_SOURCE_INVALID: { class: 'INVALID', scope: 'SOURCE' },
  CLAIM_DRAFT_SOURCE_STALE: { class: 'STALE', scope: 'SOURCE' },
  CLAIM_DRAFT_NO_DIAGNOSES: { class: 'INCOMPLETE', scope: 'DIAGNOSIS' },
  CLAIM_DRAFT_DIAGNOSIS_INVALID: { class: 'INVALID', scope: 'DIAGNOSIS' },
  CLAIM_DRAFT_PRIMARY_ROLE_MISSING: { class: 'INCOMPLETE', scope: 'DIAGNOSIS' },
  CLAIM_DRAFT_PRIMARY_ROLE_MULTIPLE: { class: 'INVALID', scope: 'DIAGNOSIS' },
  CLAIM_DRAFT_POINTER_CORRUPT: { class: 'INVALID', scope: 'POINTER' },
  CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING: { class: 'INCOMPLETE', scope: 'POINTER' },
  CLAIM_DRAFT_PRICING_RUN_MISSING: { class: 'INCOMPLETE', scope: 'PRICING' },
  CLAIM_DRAFT_COMMERCIAL_MISMATCH: { class: 'INVALID', scope: 'COMMERCIAL' },
  CLAIM_DRAFT_PRICING_INTEGRITY: { class: 'INVALID', scope: 'PRICING' },
  CLAIM_DRAFT_PRICING_INCOMPLETE: { class: 'INCOMPLETE', scope: 'PRICING' },
  CLAIM_DRAFT_PRICING_STALE: { class: 'STALE', scope: 'PRICING' },
  CLAIM_DRAFT_STRUCTURE_STALE: { class: 'STALE', scope: 'LINE' },
  CLAIM_DRAFT_UNSUPPORTED_RULE: { class: 'INCOMPLETE', scope: 'JURISDICTION' },
  CLAIM_DRAFT_JURISDICTION_RULES_NOT_EVALUATED: { class: 'ADVISORY', scope: 'JURISDICTION' },
} as const satisfies Record<string, { class: FindingClass; scope: OwnerScope }>

export type FindingCode = keyof typeof findingCatalogue
export const findingCodes = Object.keys(findingCatalogue) as FindingCode[]

export type DraftFinding = {
  ordinal: number
  findingCode: FindingCode
  severity: FindingSeverity
  ownerScope: OwnerScope
  relatedClaimLineId: string | null
  relatedClaimDiagnosisId: string | null
}

// §3/§7 — the exact lineage the draft was assembled from. Identifiers only: no patient, member, code
// text, clinical narrative, price or external representation.
export type DraftLineageDto = {
  claimId: string
  claimContractVersion: string
  handoffSchemaVersion: string
  readinessAssessmentId: string
  validationRunId: string
  serviceDate: string
  facilityRegulatoryProfileId: string
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
}

export type DraftLineDto = {
  claimLineId: string
  sequence: number
  encounterActivityId: string | null
  // Exact source facts, read from the owner at assembly time. Quantity is a decimal string.
  serviceId: string | null
  procedureCodeId: string | null
  quantity: string | null
  unitCode: string | null
  modifierCodes: string[]
  sourceRemoved: boolean
  // Active ClaimDiagnosis ids, in ClaimDiagnosis.sequence order.
  claimDiagnosisIds: string[]
}

export type DraftDiagnosisDto = {
  claimDiagnosisId: string
  sequence: number
  encounterDiagnosisId: string
  roleCode: string
}

export type DraftPricingDto = {
  pricingRunId: string
  pricingContractVersion: string
  inputStructureFingerprint: string
  overallResult: string
  lineCount: number
  pricedCount: number
  currencyCode: string | null
  totalExtendedTariffAmount: string | null
  lines: { claimLineId: string; lineSequenceAtEvaluation: number; outcome: string; extendedTariffAmount: string | null }[]
}

// §3/§4 step 8 — the versioned read-only draft. `handoffRefusal` names the A5.9 refusal code when the
// bound handoff could not be composed; it is never a lifecycle value.
export type ClaimDraftDto = {
  draftContractVersion: string
  outcome: DraftOutcome
  assemblyFingerprint: string
  lineage: DraftLineageDto
  handoffRefusal: string | null
  lines: DraftLineDto[]
  diagnoses: DraftDiagnosisDto[]
  pricing: DraftPricingDto | null
  findings: DraftFinding[]
  evaluatedAt: string
}

export type DraftAssessmentSummaryDto = {
  id: string
  claimId: string
  pricingRunId: string
  draftContractVersion: string
  handoffAssessmentId: string
  outcome: string
  assemblyFingerprint: string
  pricingInputFingerprint: string
  activeLineCount: number
  activeDiagnosisCount: number
  findingCount: number
  evaluatedAt: string
  createdByUserId: string
  createdAt: string
}

export type DraftAssessmentDto = DraftAssessmentSummaryDto & { findings: DraftFinding[] }
export type DraftAssessmentListDto = { items: DraftAssessmentSummaryDto[] }

// §8 — refusals. A persisted INCOMPLETE, STALE or INVALID assessment is a success, not an error.
export type ClaimDraftErrorCode = Extract<ClaimStructureErrorCode, 'VALIDATION_ERROR' | 'NOT_FOUND'> | 'CLAIM_DRAFT_INTEGRITY_CONFLICT' | 'CLAIM_DRAFT_WRITE_CONFLICT'

export type ClaimDraftResult<T> = { ok: true; value: T } | { ok: false; code: ClaimDraftErrorCode; message: string }
