const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeVersion(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function isRuleVersionUuid(value: string): boolean {
  return uuidShape.test(value)
}

export const ruleEffectTypes = [
  'REFERENCE_ONLY',
  'PRICE_EFFECT',
  'TARIFF_EFFECT',
  'CLAIM_FORMAT_EFFECT',
  'CLAIM_EDIT_EFFECT',
  'REIMBURSEMENT_EFFECT',
  'AUTHORIZATION_REQUIREMENT_EFFECT',
  'ELIGIBILITY_REQUIREMENT_EFFECT',
  'DOCUMENTATION_REQUIREMENT_EFFECT',
] as const

export type RuleEffectType = (typeof ruleEffectTypes)[number]

export function isRuleEffectType(value: unknown): value is RuleEffectType {
  return typeof value === 'string' && (ruleEffectTypes as readonly string[]).includes(value)
}

export function normalizeEffectType(value: unknown): RuleEffectType | null {
  const trimmed = normalizeTrimmedString(value)
  if (!trimmed) return null
  return isRuleEffectType(trimmed) ? trimmed : null
}
