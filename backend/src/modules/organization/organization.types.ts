export type OrganizationDto = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type ServiceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServiceErrorCode; message: string }
