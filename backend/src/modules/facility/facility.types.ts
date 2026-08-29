export type FacilityDto = {
  id: string
  organizationId: string
  name: string
  createdAt: string
  updatedAt: string
}

export type FacilityErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type FacilityResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FacilityErrorCode; message: string }
