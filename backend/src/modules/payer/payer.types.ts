export type PayerDto = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type PayerListDto = {
  items: PayerDto[]
}

export type PayerErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type PayerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PayerErrorCode; message: string }
