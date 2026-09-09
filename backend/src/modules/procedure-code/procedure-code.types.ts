export type ProcedureCodeDto = {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  codeSystem: string | null
  externalCode: string | null
  createdAt: string
  updatedAt: string
}

export type ProcedureCodeListDto = {
  items: ProcedureCodeDto[]
}

export type ProcedureCodeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type ProcedureCodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProcedureCodeErrorCode; message: string }
