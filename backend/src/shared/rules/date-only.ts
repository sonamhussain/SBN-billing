// Audit F07 — the single strict date boundary shared by every A3 module. Dates are stored as
// UTC calendar days (engineering convention, consistent with @db.Date columns); this module makes
// no claim about regulatory calendars.
//
// A YYYY-MM-DD shape is not proof of a real date: `new Date('2026-02-31T00:00:00.000Z')` silently
// becomes 2026-03-03. Every parser here therefore round-trips the constructed value back to the
// exact input and rejects anything that does not survive, so a caller can never ask about one day
// and have another day evaluated.

const dateOnlyShape = /^\d{4}-\d{2}-\d{2}$/

export function isValidInstant(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

// A real calendar day in YYYY-MM-DD form, or null. Rejects overflowing days/months (2026-02-31,
// 2026-04-31, 2026-02-29, 2100-02-29), timestamps, padding and non-strings.
export function parseStrictDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !dateOnlyShape.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!isValidInstant(date)) return null
  if (date.toISOString().slice(0, 10) !== value) return null
  return date
}

export type DateOnlyInput = { present: false } | { present: true; valid: false } | { present: true; valid: true; value: Date | null }

// Tri-state optional field: absent (leave unchanged / not provided), explicit null (clear — only
// where the calling domain permits it), or present. A present value that is not a real calendar
// day is invalid and must be rejected by the caller; it is never converted to null.
export function normalizeDateOnlyField(value: unknown): DateOnlyInput {
  if (value === undefined) return { present: false }
  if (value === null) return { present: true, valid: true, value: null }
  const date = parseStrictDateOnly(value)
  if (!date) return { present: true, valid: false }
  return { present: true, valid: true, value: date }
}

export function formatDateOnly(date: Date | null): string | null {
  if (!isValidInstant(date)) return null
  return date.toISOString().slice(0, 10)
}

// Audit F02 — the calendar date of an instant, in UTC, as a date-only value (UTC midnight). UTC is
// the explicit engineering convention, consistent with how date-only values are stored; it is not
// a claim about UAE regulatory calendar rules, and it never reads the host machine's time zone.
// Returns null for a non-finite instant so callers fail closed.
export function utcDateOf(instant: Date): Date | null {
  if (!isValidInstant(instant)) return null
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()))
}

// The one inclusive effective-window rule: a valid effectiveFrom is required, effectiveTo may be
// null (open-ended), and effectiveFrom <= date <= effectiveTo. Fails closed on any non-finite
// input and on a contradictory period (effectiveFrom after effectiveTo) — such a period is never
// "in force", whatever the date.
export function isEffectiveOn(effectiveFrom: Date | null, effectiveTo: Date | null, date: Date): boolean {
  if (!isValidInstant(effectiveFrom) || !isValidInstant(date)) return false
  if (effectiveTo !== null && !isValidInstant(effectiveTo)) return false
  if (effectiveTo !== null && effectiveFrom.getTime() > effectiveTo.getTime()) return false
  if (date.getTime() < effectiveFrom.getTime()) return false
  if (effectiveTo !== null && date.getTime() > effectiveTo.getTime()) return false
  return true
}

const timestampShape = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

// An explicit ISO-8601 instant with a real calendar day, in-range clock fields and an explicit
// zone (Z or ±HH:MM). Rejects bare dates, years, free-text dates and overflowing values that
// `new Date(string)` would otherwise accept or roll forward.
export function parseStrictTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const match = timestampShape.exec(value)
  if (!match) return null
  const [, datePart, hours, minutes, seconds, zone] = match
  if (!parseStrictDateOnly(datePart)) return null
  if (Number(hours) > 23 || Number(minutes) > 59 || (seconds !== undefined && Number(seconds) > 59)) return null
  if (zone !== 'Z') {
    const [zoneHours, zoneMinutes] = zone.slice(1).split(':').map(Number)
    if (zoneHours > 23 || zoneMinutes > 59) return null
  }
  const instant = new Date(value)
  return isValidInstant(instant) ? instant : null
}
