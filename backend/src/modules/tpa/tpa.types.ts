export type TpaDto = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type TpaListDto = {
  items: TpaDto[]
}

export type TpaErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type TpaResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TpaErrorCode; message: string }
