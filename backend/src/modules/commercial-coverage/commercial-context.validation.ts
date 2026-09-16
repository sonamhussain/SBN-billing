const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCommercialContextUuid(value: string): boolean {
  return uuidShape.test(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

// productCode / contractKey / tariffKey — stable identity keys, never external payer/contract/
// tariff IDs (those belong in A2.9 ExternalIdentifier, not here — see REF-01 §6).
export function normalizeCommercialKey(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeCommercialDisplayName(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export type OptionalUuidFieldResult = { valid: true; value: string | null } | { valid: false }

export function normalizeOptionalCommercialUuidField(value: unknown): OptionalUuidFieldResult {
  if (value === undefined || value === null) return { valid: true, value: null }
  if (typeof value !== 'string' || !isCommercialContextUuid(value)) return { valid: false }
  return { valid: true, value }
}
