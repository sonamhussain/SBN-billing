import type { TargetType } from './external-identifier.target.ts'

export type ExternalIdentifierDto = {
  id: string
  organizationId: string
  sourceSystem: string
  externalValue: string
  target: {
    type: TargetType
    id: string
  }
  createdAt: string
  updatedAt: string
}

export type ExternalIdentifierListDto = {
  items: ExternalIdentifierDto[]
}

export type ExternalIdentifierErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type ExternalIdentifierResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ExternalIdentifierErrorCode; message: string }
