import { formatDateOnly, isValidInstant, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import type { FacilityRegulatoryProfileDto } from './facility-regulatory.types.ts'

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
import type { DateOnlyInput } from '../../shared/rules/date-only.ts'

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

export type ActiveClosureDecision = { ok: true; effectiveTo: Date } | { ok: false; message: string }

// Audit F05 / REF-01 T24: the only change an ACTIVE profile accepts is ONE finite closure of an
// open-ended period. Clearing effectiveTo (reopening), closing an already-closed period again,
// extending it or shortening it are all rejected — an already finite ACTIVE period is historical
// governance and is not casually revised. Closing can only shrink a period, so it can never
// create an overlap with another ACTIVE profile.
export function decideActiveProfileClosure(
  existing: { effectiveFrom: Date; effectiveTo: Date | null },
  requestedEffectiveTo: DateOnlyInput,
): ActiveClosureDecision {
  if (!requestedEffectiveTo.present)
    return { ok: false, message: 'effectiveTo is required to close an ACTIVE regulatory profile' }
  if (!requestedEffectiveTo.valid) return { ok: false, message: 'effectiveTo must be a YYYY-MM-DD date' }
  if (requestedEffectiveTo.value === null)
    return { ok: false, message: 'an ACTIVE regulatory profile cannot be reopened; effectiveTo cannot be cleared' }
  if (existing.effectiveTo !== null)
    return {
      ok: false,
      message: 'this ACTIVE regulatory profile is already closed; its effective period can no longer be changed',
    }
  if (requestedEffectiveTo.value.getTime() < existing.effectiveFrom.getTime())
    return { ok: false, message: 'effectiveFrom must not be after effectiveTo' }
  return { ok: true, effectiveTo: requestedEffectiveTo.value }
}

// The canonical wire shape of a regulatory profile. It lives here, beside the other pure helpers,
// because A4.9 returns the EXACT profile an Encounter bound itself to at write time and must not
// reproduce this shape. Note that `status` is carried through as stored: a consumer reading a
// historical binding needs to see what the profile's lifecycle state is NOW without that state
// being allowed to change which row was returned.
export function toFacilityRegulatoryProfileDto(record: {
  id: string
  facilityId: string
  jurisdictionCode: string
  regulatoryAuthorityCode: string
  effectiveFrom: Date
  effectiveTo: Date | null
  status: string
  createdAt: Date
  updatedAt: Date
}): FacilityRegulatoryProfileDto {
  return {
    id: record.id,
    facilityId: record.facilityId,
    jurisdictionCode: record.jurisdictionCode,
    regulatoryAuthorityCode: record.regulatoryAuthorityCode,
    effectiveFrom: formatDateOnly(record.effectiveFrom) as string,
    effectiveTo: formatDateOnly(record.effectiveTo),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
