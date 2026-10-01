// A5.5 — which ProviderContract, and which exact VERIFIED TariffScheduleVersion beneath it, provably
// apply to one Encounter's current commercial, facility and service-date context.
//
// This is commercial IDENTITY only. Nothing is priced, nothing is persisted and nothing is audited:
// the answer is recomputed in one read-only snapshot every time it is asked, so it can never go stale
// in storage. Downstream owners (A5.7/A5.8 provenance, A6 ClaimSubmission) freeze the exact IDs they
// use when they need history.

export type PreClaimCommercialContextV1 = {
  schemaVersion: 'PreClaimCommercialContextV1'
  resolvedAt: string
  organizationId: string
  encounterId: string
  serviceDate: string
  facilityId: string
  facilityRegulatoryProfileId: string

  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null

  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
}

// Why a resolution failed. The first six are the doc's §6 list; NO_SELECTED_MEMBERSHIP and
// TARIFF_INTEGRITY_CONFLICT were added by owner decision so that neither case borrows a code that
// names the wrong owner.
export const resolutionReasons = [
  'A4_INTEGRITY_CONFLICT',
  'NO_SELECTED_MEMBERSHIP',
  'NO_APPLICABLE_CONTRACT',
  'AMBIGUOUS_CONTRACT',
  'TARIFF_INTEGRITY_CONFLICT',
  'NO_APPLICABLE_TARIFF_VERSION',
  'AMBIGUOUS_TARIFF_VERSION',
  'INDETERMINATE_TARIFF_DATES',
] as const
export type ResolutionReason = (typeof resolutionReasons)[number]

export type PreClaimCommercialContextErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  // Stored data contradicts itself (A4 context, or a tariff master row).
  | 'INTEGRITY_CONFLICT'
  // Stored data is sound, but it does not resolve to exactly one contract and one tariff version.
  | 'COMMERCIAL_CONTEXT_UNRESOLVED'

export type PreClaimCommercialContextResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PreClaimCommercialContextErrorCode; message: string; reason?: ResolutionReason }
