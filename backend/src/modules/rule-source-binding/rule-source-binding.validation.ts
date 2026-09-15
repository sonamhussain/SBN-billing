const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRuleSourceBindingUuid(value: string): boolean {
  return uuidShape.test(value)
}

export const sourceRoles = ['GOVERNING', 'SUPPORTING'] as const

export type SourceRole = (typeof sourceRoles)[number]

export function isSourceRole(value: unknown): value is SourceRole {
  return typeof value === 'string' && (sourceRoles as readonly string[]).includes(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeSourceRole(value: unknown): SourceRole | null {
  const trimmed = normalizeTrimmedString(value)
  if (!trimmed) return null
  return isSourceRole(trimmed) ? trimmed : null
}

export const executabilityBlockerCodes = [
  'RULE_UNVERIFIED',
  'RULE_NOT_EFFECTIVE',
  'APPLICABILITY_MISMATCH',
  'MISSING_GOVERNING_SOURCE',
  'SOURCE_NOT_ACTIVE',
  'AUTHORITY_UNVERIFIED',
  'INTERPRETATION_UNVERIFIED',
  'SOURCE_NOT_EFFECTIVE',
  'SOURCE_NOT_PUBLISHED',
  'DEPENDENCY_UNRESOLVED',
  'SOURCE_CONFLICT',
  'JURISDICTION_INCOMPATIBLE',
  'OWNERSHIP_MISMATCH',
  'SOURCE_EFFECT_INCOMPATIBLE',
] as const

export type ExecutabilityBlockerCode = (typeof executabilityBlockerCodes)[number]

export function isExecutabilityBlockerCode(value: string): value is ExecutabilityBlockerCode {
  return (executabilityBlockerCodes as readonly string[]).includes(value)
}
