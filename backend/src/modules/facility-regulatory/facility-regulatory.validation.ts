import { isValidInstant, parseStrictDateOnly } from '../../shared/rules/date-only.ts'

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isFacilityRegulatoryProfileUuid(value: string): boolean {
  return uuidShape.test(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeRegulatoryAuthorityCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export const facilityRegulatoryProfileStatuses = ['INACTIVE', 'ACTIVE'] as const
export type FacilityRegulatoryProfileStatus = (typeof facilityRegulatoryProfileStatuses)[number]

// Audit F07: this module used to carry its own copy of the date parser. It now reuses the single
// shared strict boundary; the names stay exported so existing importers are unchanged.
export { normalizeDateOnlyField, formatDateOnly, type DateOnlyInput } from '../../shared/rules/date-only.ts'

export function normalizeRequiredDateOnly(value: unknown): Date | null {
  return parseStrictDateOnly(value)
}

// Two [effectiveFrom, effectiveTo] ranges overlap when each range's start is not after the
// other range's end — a null effectiveTo is treated as open-ended (never closes the range).
// A non-finite bound cannot prove the ranges are disjoint, so it is treated as overlapping and
// the caller's non-overlap guard fails closed.
export function rangesOverlap(
  aFrom: Date,
  aTo: Date | null,
  bFrom: Date,
  bTo: Date | null,
): boolean {
  if (!isValidInstant(aFrom) || !isValidInstant(bFrom)) return true
  if ((aTo !== null && !isValidInstant(aTo)) || (bTo !== null && !isValidInstant(bTo))) return true
  const aStartsBeforeOrOnBEnd = bTo === null || aFrom.getTime() <= bTo.getTime()
  const bStartsBeforeOrOnAEnd = aTo === null || bFrom.getTime() <= aTo.getTime()
  return aStartsBeforeOrOnBEnd && bStartsBeforeOrOnAEnd
}
