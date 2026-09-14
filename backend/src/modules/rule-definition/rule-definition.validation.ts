const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeRuleKey(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeDisplayName(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function isRuleDefinitionUuid(value: string): boolean {
  return uuidShape.test(value)
}
