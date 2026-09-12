const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const sourceCategories = [
  'REGULATORY_AUTHORITY',
  'CLAIMS_STANDARD',
  'TARIFF',
  'PROVIDER_CONTRACT',
  'PAYER_POLICY',
  'TPA_POLICY',
  'CLINICAL_STANDARD',
  'RESEARCH_PUBLICATION',
  'OPERATIONAL_GUIDANCE',
  'OTHER',
] as const

export type SourceCategory = (typeof sourceCategories)[number]

export function isSourceCategory(value: unknown): value is SourceCategory {
  return typeof value === 'string' && (sourceCategories as readonly string[]).includes(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeIssuingAuthority(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeReferenceNumber(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeTitle(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeSourceCategory(value: unknown): SourceCategory | null {
  const trimmed = normalizeTrimmedString(value)
  if (!trimmed) return null
  return isSourceCategory(trimmed) ? trimmed : null
}

export function isRuleSourceUuid(value: string): boolean {
  return uuidShape.test(value)
}
