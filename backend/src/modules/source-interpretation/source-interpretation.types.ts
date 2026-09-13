export type SourceInterpretationDto = {
  id: string
  sourceVersionId: string
  interpretationVersion: string
  normalizedInterpretationRef: string
  verificationStatus: string
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export type SourceInterpretationListDto = {
  items: SourceInterpretationDto[]
}

export type SourceInterpretationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type SourceInterpretationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SourceInterpretationErrorCode; message: string }
