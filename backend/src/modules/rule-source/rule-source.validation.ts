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

// Audit F10 — the identity a rule source governs under. Once any version exists, every stored
// version, interpretation and binding was evaluated against these three fields, and A3.7/A3.8 read
// them live, so changing one would silently relabel historical decisions into a different
// authority class. Display-only fields (referenceNumber, title) are not identity.
export const ruleSourceIdentityFields = ['jurisdictionCode', 'issuingAuthority', 'sourceCategory'] as const

export type RuleSourceIdentityField = (typeof ruleSourceIdentityFields)[number]

type RuleSourceIdentity = Record<RuleSourceIdentityField, string>

// Pure: which identity fields a patch would actually change. A field the caller omitted, or
// re-sent with the value already stored, is not a change.
export function frozenIdentityChanges(
  existing: RuleSourceIdentity,
  requested: Partial<Record<RuleSourceIdentityField, string | null>>,
): RuleSourceIdentityField[] {
  return ruleSourceIdentityFields.filter((field) => {
    const value = requested[field]
    return typeof value === 'string' && value !== existing[field]
  })
}

export function frozenIdentityMessage(changes: readonly string[]): string {
  return `${changes.join(', ')} cannot be changed once this rule source has versions; create a new rule source instead`
}
