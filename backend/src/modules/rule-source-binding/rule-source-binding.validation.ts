import { activationBlockerCodes, type ActivationBlockerCode } from '../rule-source-version/rule-source-version.activation.ts'

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

const activationBlockerCodeSet: ReadonlySet<string> = new Set(activationBlockerCodes)

function isActivationBlockerCode(value: string): value is ActivationBlockerCode {
  return activationBlockerCodeSet.has(value)
}

// Conservative public code for any upstream blocking reason A3.7 cannot name precisely. It is an
// eligibility blocker only — it never touches the stored activationStatus.
export const unmappedBlockerFallback: ExecutabilityBlockerCode = 'SOURCE_NOT_ACTIVE'

// Exhaustive over A3.3's exported blocker union: adding a code to A3.3 without deciding its A3.7
// meaning is a compile error here, not a silent pass at runtime.
function translateActivationBlockerCode(code: ActivationBlockerCode): ExecutabilityBlockerCode {
  switch (code) {
    // A3.3 raises ONLY EFFECTIVE_DATE_INCOMPLETE when effectiveFrom is missing (never also
    // SOURCE_NOT_EFFECTIVE), which is how an undated source used to pass the gate.
    case 'EFFECTIVE_DATE_INCOMPLETE':
    case 'CONTRADICTORY_DATES':
      return 'SOURCE_NOT_EFFECTIVE'
    case 'SOURCE_NOT_PUBLISHED':
    case 'SOURCE_NOT_EFFECTIVE':
    case 'AUTHORITY_UNVERIFIED':
    case 'INTERPRETATION_UNVERIFIED':
    case 'JURISDICTION_INCOMPATIBLE':
    case 'OWNERSHIP_MISMATCH':
    case 'DEPENDENCY_UNRESOLVED':
    case 'SOURCE_CONFLICT':
      return code
    default: {
      const unreachable: never = code
      return unreachable
    }
  }
}

export type BlockerTranslation = {
  // Public A3.7 codes: unique, sorted, always inside the fifteen-code vocabulary.
  codes: ExecutabilityBlockerCode[]
  // The exact upstream values that had no precise mapping. Internal diagnostics and test evidence
  // only — never returned in an API response or added to the public vocabulary.
  unmappedReasons: string[]
}

// Lossless, fail-closed translation of upstream (A3.3) blocker reasons into A3.7's vocabulary:
//   - an A3.3 code is translated by the exhaustive switch above;
//   - an existing A3.7 code passes through unchanged;
//   - anything else — an unknown future code, an empty string, a non-string, or a prototype-like
//     name such as "constructor" — becomes the conservative SOURCE_NOT_ACTIVE fallback.
// Only a genuinely empty input list yields an empty result, so a non-empty blocker response can
// never silently turn into success. No lookup goes through an ordinary object's prototype.
export function translateActivationBlockers(upstream: readonly unknown[]): BlockerTranslation {
  const codes = new Set<ExecutabilityBlockerCode>()
  const unmappedReasons: string[] = []

  for (const entry of upstream) {
    if (typeof entry === 'string' && isActivationBlockerCode(entry)) {
      codes.add(translateActivationBlockerCode(entry))
      continue
    }
    if (typeof entry === 'string' && isExecutabilityBlockerCode(entry)) {
      codes.add(entry)
      continue
    }
    codes.add(unmappedBlockerFallback)
    unmappedReasons.push(typeof entry === 'string' ? entry : `<non-string:${typeof entry}>`)
  }

  return { codes: [...codes].sort(), unmappedReasons }
}

export function toExecutabilityBlockerCodes(upstream: readonly unknown[]): ExecutabilityBlockerCode[] {
  return translateActivationBlockers(upstream).codes
}
