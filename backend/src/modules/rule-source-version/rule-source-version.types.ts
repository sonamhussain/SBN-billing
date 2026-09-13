export type RuleSourceVersionDto = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  publicationStatus: string
  publicationDate: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  activationStatus: string
  activationBlockers: string[]
  activatedAt: string | null
  suspendedAt: string | null
  supersededAt: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export type RuleSourceVersionListDto = {
  items: RuleSourceVersionDto[]
}

export type ActivationEvaluationDto = {
  blockers: string[]
}

export type RuleSourceVersionErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type RuleSourceVersionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleSourceVersionErrorCode; message: string }
