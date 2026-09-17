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
  'SOURCE_CONTEXT_INCOMPATIBLE',
] as const

export type ExecutabilityBlockerCode = (typeof executabilityBlockerCodes)[number]

export function isExecutabilityBlockerCode(value: string): value is ExecutabilityBlockerCode {
  return (executabilityBlockerCodes as readonly string[]).includes(value)
}

// A3.3's activation evaluator can return two date blockers that are not part of A3.7's published
// fifteen-code vocabulary. They used to be filtered out along with every other unrecognised code,
// which removed them from the set that decides whether a governing candidate passes — so a source
// version with no effectiveFrom (for which the evaluator raises ONLY EFFECTIVE_DATE_INCOMPLETE,
// never SOURCE_NOT_EFFECTIVE) passed the gate. Both are mapped onto SOURCE_NOT_EFFECTIVE, which
// already means "not validly in force for this date", so the public vocabulary stays unchanged.
const activationDateBlockerAliases: Readonly<Record<string, ExecutabilityBlockerCode>> = {
  EFFECTIVE_DATE_INCOMPLETE: 'SOURCE_NOT_EFFECTIVE',
  CONTRADICTORY_DATES: 'SOURCE_NOT_EFFECTIVE',
}

// Translates A3.3 activation blocker codes into A3.7 executability blocker codes. Codes in A3.7's
// vocabulary pass through, the two date codes are aliased, anything else is dropped. The result is
// unique and sorted, and never contains a code outside the public vocabulary.
export function toExecutabilityBlockerCodes(activationCodes: readonly string[]): ExecutabilityBlockerCode[] {
  const result = new Set<ExecutabilityBlockerCode>()
  for (const code of activationCodes) {
    if (isExecutabilityBlockerCode(code)) {
      result.add(code)
      continue
    }
    const alias = activationDateBlockerAliases[code]
    if (alias) result.add(alias)
  }
  return [...result].sort()
}
