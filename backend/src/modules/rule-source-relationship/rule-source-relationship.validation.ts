const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const relationshipTypes = ['SUPERSEDES', 'AMENDS', 'REFERENCES', 'DEPENDS_ON', 'CONFLICTS_WITH'] as const

export type RelationshipType = (typeof relationshipTypes)[number]

export function isRelationshipType(value: unknown): value is RelationshipType {
  return typeof value === 'string' && (relationshipTypes as readonly string[]).includes(value)
}

export function isRuleSourceRelationshipUuid(value: string): boolean {
  return uuidShape.test(value)
}

export const relationshipDirections = ['incoming', 'outgoing', 'all'] as const

export type RelationshipDirection = (typeof relationshipDirections)[number]

export function normalizeRelationshipDirection(value: unknown): RelationshipDirection {
  if (typeof value === 'string' && (relationshipDirections as readonly string[]).includes(value)) {
    return value as RelationshipDirection
  }
  return 'all'
}
