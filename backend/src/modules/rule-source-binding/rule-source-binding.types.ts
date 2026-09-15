export type RuleSourceBindingDto = {
  id: string
  ruleVersionId: string
  sourceInterpretationId: string
  sourceRole: string
  createdAt: string
}

export type RuleSourceBindingListDto = {
  items: RuleSourceBindingDto[]
}

export type ExecutabilityGateStatus = 'BLOCKED' | 'POTENTIALLY_ALLOWED' | 'REFERENCE_ONLY'

export type ExecutabilityEvaluationDto = {
  gateStatus: ExecutabilityGateStatus
  compatibilityPolicyVersion: string
  blockers: string[]
  matchedApplicabilityIds: string[]
  governingBindingIds: string[]
  supportingBindingIds: string[]
  candidateSourceInterpretationIds: string[]
  nextGate: 'A3.8_PRECEDENCE' | null
}

export type RuleSourceBindingErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type RuleSourceBindingResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleSourceBindingErrorCode; message: string }
