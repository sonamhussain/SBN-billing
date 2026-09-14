export type RuleSourceRelationshipDto = {
  id: string
  fromSourceVersionId: string
  toSourceVersionId: string
  relationshipType: string
  createdAt: string
}

export type RuleSourceRelationshipListItemDto = RuleSourceRelationshipDto & {
  direction: 'incoming' | 'outgoing'
}

export type RuleSourceRelationshipListDto = {
  items: RuleSourceRelationshipListItemDto[]
}

export type RuleSourceRelationshipErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type RuleSourceRelationshipResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleSourceRelationshipErrorCode; message: string }
