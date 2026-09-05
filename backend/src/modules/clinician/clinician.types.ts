export type ClinicianDto = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type ClinicianListDto = {
  items: ClinicianDto[]
}

export type ClinicianErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type ClinicianResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ClinicianErrorCode; message: string }
