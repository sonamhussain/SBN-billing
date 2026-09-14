export type RuleDefinitionDto = {
  id: string
  organizationId: string | null
  ruleKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
  createdAt: string
  updatedAt: string
}

export type RuleDefinitionListDto = {
  items: RuleDefinitionDto[]
}

export type RuleDefinitionErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type RuleDefinitionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleDefinitionErrorCode; message: string }
