export type RuleApplicabilityDto = {
  id: string
  ruleVersionId: string
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
  createdAt: string
}

export type RuleApplicabilityListDto = {
  items: RuleApplicabilityDto[]
}

export type ApplicabilityEvaluationDto = {
  matches: boolean
  matchedApplicabilityIds: string[]
}

export type RuleApplicabilityErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type RuleApplicabilityResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleApplicabilityErrorCode; message: string }
