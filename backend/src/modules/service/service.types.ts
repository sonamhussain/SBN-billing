export type ServiceDto = {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type ServiceListDto = {
  items: ServiceDto[]
}

export type ServiceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServiceErrorCode; message: string }
