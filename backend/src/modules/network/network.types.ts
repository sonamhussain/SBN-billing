export type NetworkDto = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type NetworkListDto = {
  items: NetworkDto[]
}

export type NetworkErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type NetworkResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: NetworkErrorCode; message: string }
