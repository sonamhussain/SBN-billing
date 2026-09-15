export type ProviderContractDto = {
  id: string
  organizationId: string
  insuranceProductId: string | null
  productNetworkId: string | null
  contractKey: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type ProviderContractListDto = {
  items: ProviderContractDto[]
}

export type ContractFacilityDto = {
  id: string
  providerContractId: string
  facilityId: string
  createdAt: string
}

export type ContractFacilityListDto = {
  items: ContractFacilityDto[]
}

export type ProviderContractErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type ProviderContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProviderContractErrorCode; message: string }
