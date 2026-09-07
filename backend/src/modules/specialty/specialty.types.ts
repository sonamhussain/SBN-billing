export type SpecialtyDto = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type SpecialtyListDto = {
  items: SpecialtyDto[]
}

export type SpecialtyErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type SpecialtyResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SpecialtyErrorCode; message: string }
