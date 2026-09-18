import { parseStrictDateOnly } from '../../shared/rules/date-only.ts'

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

export function normalizeRawEvidenceRef(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function isRuleSourceVersionUuid(value: string): boolean {
  return uuidShape.test(value)
}

export const publicationStatuses = ['DRAFT', 'PUBLISHED'] as const
export type PublicationStatus = (typeof publicationStatuses)[number]

export const sourceVerificationStatuses = ['UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'REJECTED'] as const
export type SourceVerificationStatus = (typeof sourceVerificationStatuses)[number]

// Statuses whose effective dates are frozen because the version is, or has become, governance.
export const activationLockedStatuses: readonly string[] = ['ACTIVE', 'SUSPENDED', 'RETIRED', 'SUPERSEDED']

// Audit F09: the freeze follows the durable ever-activated fact as well as the current status, so a
// failed resume — which lands on BLOCKED and must clear activatedAt to satisfy
// rule_source_versions_blocked_chk — cannot reopen the effective dates of a version that was
// already governing.
export function areEffectiveDatesFrozen(activationStatus: string, everActivated: boolean): boolean {
  return everActivated || activationLockedStatuses.includes(activationStatus)
}

export const activationStatuses = ['INACTIVE', 'BLOCKED', 'ACTIVE', 'SUSPENDED', 'SUPERSEDED', 'RETIRED'] as const
export type ActivationStatus = (typeof activationStatuses)[number]

export function isSourceVerificationStatus(value: unknown): value is SourceVerificationStatus {
  return typeof value === 'string' && (sourceVerificationStatuses as readonly string[]).includes(value)
}

// Audit F07: date parsing lives in the one shared strict boundary. These names are kept as thin
// wrappers so every existing importer (A3.3, RuleVersion, commercial coverage, dataset
// maintenance, A3.7) picks up calendar-exact validation without a second date policy.
export { normalizeDateOnlyField, formatDateOnly, type DateOnlyInput } from '../../shared/rules/date-only.ts'

export function normalizeBusinessDate(value: unknown): Date | null {
  return parseStrictDateOnly(value)
}

export function normalizeContextJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}
