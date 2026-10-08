// FE-04 — the A5.5 PreClaimCommercialContextV1 read: which provider contract and which exact VERIFIED
// tariff schedule version apply to the Encounter, resolved by the server for the Encounter's own service
// date. It carries identifiers only and no price. When it cannot resolve, the backend answers 409 with a
// reason (no applicable or ambiguous contract/tariff, indeterminate dates, integrity conflict); that answer
// is shown as it is, never replaced by a fallback.
export type PreClaimCommercialContext = {
  schemaVersion: 'PreClaimCommercialContextV1'
  resolvedAt: string
  encounterId: string
  serviceDate: string
  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
}

export type ProviderContractLabel = { id: string; displayName: string; contractKey: string; effectiveFrom: string; effectiveTo: string | null }
export type TariffScheduleLabel = { id: string; displayName: string; tariffKey: string }
export type TariffScheduleVersionLabel = {
  id: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
}
