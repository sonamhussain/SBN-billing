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

const dateOnlyShape = /^\d{4}-\d{2}-\d{2}$/

export type DateOnlyInput = { present: false } | { present: true; valid: false } | { present: true; valid: true; value: Date | null }

// Distinguishes "field absent" (leave untouched) from "field explicitly null" (clear) from
// "field present but malformed" (reject) — mirrors A3.3's normalizeDateOnlyField.
export function normalizeDateOnlyField(value: unknown): DateOnlyInput {
  if (value === undefined) return { present: false }
  if (value === null) return { present: true, valid: true, value: null }
  if (typeof value !== 'string' || !dateOnlyShape.test(value)) return { present: true, valid: false }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return { present: true, valid: false }
  return { present: true, valid: true, value: date }
}

export function normalizeRequiredDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !dateOnlyShape.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateOnly(date: Date | null): string | null {
  if (!date) return null
  return date.toISOString().slice(0, 10)
}

// Two [effectiveFrom, effectiveTo] ranges overlap when each range's start is not after the
// other range's end — a null effectiveTo is treated as open-ended (never closes the range).
export function rangesOverlap(
  aFrom: Date,
  aTo: Date | null,
  bFrom: Date,
  bTo: Date | null,
): boolean {
  const aStartsBeforeOrOnBEnd = bTo === null || aFrom.getTime() <= bTo.getTime()
  const bStartsBeforeOrOnAEnd = aTo === null || bFrom.getTime() <= aTo.getTime()
  return aStartsBeforeOrOnBEnd && bStartsBeforeOrOnAEnd
}
