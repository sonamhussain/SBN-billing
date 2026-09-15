export type InsuranceProductDto = {
  id: string
  organizationId: string
  payerId: string
  productCode: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type InsuranceProductListDto = {
  items: InsuranceProductDto[]
}

export type ProductNetworkDto = {
  id: string
  insuranceProductId: string
  networkId: string
  createdAt: string
}

export type ProductNetworkListDto = {
  items: ProductNetworkDto[]
}

export type InsuranceProductErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type InsuranceProductResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: InsuranceProductErrorCode; message: string }
