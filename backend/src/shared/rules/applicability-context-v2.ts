// REF-01 / R5 — the canonical, shared applicability context contract. A3.6 extends its own
// RuleApplicability table/matcher to these twelve dimensions, and A3.8 (when built) must import
// this contract rather than maintaining its own local six-field list (REF-01 §11).
export const APPLICABILITY_DIMENSIONS_V2 = [
  'facilityId',
  'facilityRegulatoryProfileId',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'providerContractId',
  'tariffScheduleId',
  'tariffScheduleVersionId',
  'serviceId',
  'procedureCodeId',
  'diagnosisCodeId',
] as const

export type ApplicabilityDimensionKeyV2 = (typeof APPLICABILITY_DIMENSIONS_V2)[number]

export type ApplicabilityContextV2 = {
  facilityId?: string | null
  // Internal/canonical context — never client-suppliable on the A3.7 executability evaluate
  // request; that endpoint resolves it server-side from facilityId + businessDate (REF-01 §10).
  // A3.6's own create/evaluate accepts it directly as an authoring-time editorial choice.
  facilityRegulatoryProfileId?: string | null
  payerId?: string | null
  tpaId?: string | null
  networkId?: string | null
  insuranceProductId?: string | null
  providerContractId?: string | null
  tariffScheduleId?: string | null
  tariffScheduleVersionId?: string | null
  serviceId?: string | null
  procedureCodeId?: string | null
  diagnosisCodeId?: string | null
}
