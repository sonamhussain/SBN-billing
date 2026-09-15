export type RuleSourceScopeDto = {
  id: string
  sourceId: string
  facilityId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  createdAt: string
}

export type RuleSourceScopeListDto = {
  items: RuleSourceScopeDto[]
}

export type RuleSourceScopeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type RuleSourceScopeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleSourceScopeErrorCode; message: string }
