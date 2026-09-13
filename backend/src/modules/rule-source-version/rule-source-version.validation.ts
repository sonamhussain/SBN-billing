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

export const activationStatuses = ['INACTIVE', 'BLOCKED', 'ACTIVE', 'SUSPENDED', 'SUPERSEDED', 'RETIRED'] as const
export type ActivationStatus = (typeof activationStatuses)[number]

export function isSourceVerificationStatus(value: unknown): value is SourceVerificationStatus {
  return typeof value === 'string' && (sourceVerificationStatuses as readonly string[]).includes(value)
}

const dateOnlyShape = /^\d{4}-\d{2}-\d{2}$/

export type DateOnlyInput = { present: false } | { present: true; valid: false } | { present: true; valid: true; value: Date | null }

// Distinguishes "field absent" (leave untouched) from "field explicitly null" (clear) from
// "field present but malformed" (reject) — a plain Date | null return cannot express all three.
export function normalizeDateOnlyField(value: unknown): DateOnlyInput {
  if (value === undefined) return { present: false }
  if (value === null) return { present: true, valid: true, value: null }
  if (typeof value !== 'string' || !dateOnlyShape.test(value)) return { present: true, valid: false }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return { present: true, valid: false }
  return { present: true, valid: true, value: date }
}

export function normalizeBusinessDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !dateOnlyShape.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateOnly(date: Date | null): string | null {
  if (!date) return null
  return date.toISOString().slice(0, 10)
}

export function normalizeContextJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}
