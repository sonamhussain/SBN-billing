export type RuleSourceVersionDto = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  createdAt: string
  updatedAt: string
}

export type RuleSourceVersionListDto = {
  items: RuleSourceVersionDto[]
}

export type RuleSourceVersionErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type RuleSourceVersionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleSourceVersionErrorCode; message: string }
