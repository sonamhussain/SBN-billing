export type RuleSourceDto = {
  id: string
  organizationId: string | null
  jurisdictionCode: string
  issuingAuthority: string
  sourceCategory: string
  referenceNumber: string
  title: string
  ownershipScope: string
  createdAt: string
  updatedAt: string
}

export type RuleSourceListDto = {
  items: RuleSourceDto[]
}

export type RuleSourceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type RuleSourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleSourceErrorCode; message: string }
