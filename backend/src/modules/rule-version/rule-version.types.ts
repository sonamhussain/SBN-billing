export type RuleVersionDto = {
  id: string
  ruleId: string
  version: string
  effectType: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export type RuleVersionListDto = {
  items: RuleVersionDto[]
}

export type RuleVersionErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type RuleVersionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleVersionErrorCode; message: string }
