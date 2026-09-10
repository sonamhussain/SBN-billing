export type DiagnosisCodeDto = {
  id: string
  organizationId: string
  code: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type DiagnosisCodeListDto = {
  items: DiagnosisCodeDto[]
}

export type DiagnosisCodeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type DiagnosisCodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: DiagnosisCodeErrorCode; message: string }
