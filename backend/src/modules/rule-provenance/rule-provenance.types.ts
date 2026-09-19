import type { RuleResolutionEvaluationBundle } from '../rule-resolution/rule-resolution.types.ts'

// A3.9 §13 — A3-PROV-1: the stable reference contract a later business module (A5/A6) freezes when
// it takes a real decision. A3.9 only defines and composes it; nothing here is persisted, and
// there is no RuleDecision table. Every ID is an SBN UUID; external identifiers never substitute.

export const provenanceContractVersion = 'A3-PROV-1' as const

export type ProvenanceContext = {
  facilityId: string | null
  facilityRegulatoryProfileId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
}

export type RuleDecisionProvenanceRefV1 = {
  provenanceContractVersion: typeof provenanceContractVersion
  // Copied verbatim from the A3.8 result — never a hard-coded policy literal.
  precedencePolicyVersion: string

  ruleDefinitionId: string
  ruleVersionId: string
  ruleVersion: string

  rulePackId: string | null
  rulePackVersionId: string | null
  rulePackVersion: string | null

  governingBindingId: string
  governingSourceId: string
  governingSourceVersionId: string
  governingSourceVersion: string
  governingSourceInterpretationId: string

  supportingBindingIds: string[]
  supportingSourceVersionIds: string[]
  matchedApplicabilityIds: string[]

  organizationId: string
  jurisdictionCode: string

  context: ProvenanceContext

  // A3.9 consumed no ReferenceDatasetVersion, so this is truthfully [] — the field exists so
  // future consumers get a stable shape.
  referenceDatasetVersionIds: string[]
  businessDate: string
  evaluationTimestamp: string
  // Copied exactly from A3.8 — never recalculated or downgraded.
  historicalOnly: boolean
}

// A3.9 §15 — internal composition errors for callers and tests. NOT a public resolver status and
// not exposed through any route.
export const provenanceCompositionErrorCodes = [
  'RESOLUTION_NOT_RESOLVED',
  'PACK_VERSION_NOT_USABLE',
  'PACK_MEMBERSHIP_MISMATCH',
  'PROVENANCE_INVARIANT_VIOLATION',
] as const

export type ProvenanceCompositionErrorCode = (typeof provenanceCompositionErrorCodes)[number]

export type ProvenanceCompositionError = { code: ProvenanceCompositionErrorCode; message: string }

export type ProvenanceResult =
  | { ok: true; value: RuleDecisionProvenanceRefV1 }
  | { ok: false; error: ProvenanceCompositionError }

// A3.9 v1.2 — the composer takes ONE inseparable A3.8 evaluation bundle. There is deliberately no
// separate context, organization or timestamp input, so pieces of two evaluations cannot be mixed.
// historicalOnly stays the A3.8 RuleVersion/source currentness flag; a historical (SUPERSEDED)
// pack version never changes it — the pack version is recorded separately.
export type ComposeProvenanceInput = {
  evaluation: RuleResolutionEvaluationBundle
  rulePackVersionId?: string | null
}
