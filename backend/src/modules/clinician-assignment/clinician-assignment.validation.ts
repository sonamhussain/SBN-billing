import { formatDateOnly, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import { assignmentCloseFields, assignmentServerOwnedFields, type AssignmentKind } from './clinician-assignment.types.ts'

// A4.2 §9/§10/§15 — the pure rules: strict calendar dates, inclusive effective periods, and
// exact-pair overlap. It reuses the shared strict date-only parser introduced by the A3 hardening
// work; there is no second, lenient parser here.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAssignmentUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

export const targetFieldFor = (kind: AssignmentKind) => (kind === 'FACILITY' ? 'facilityId' : 'specialtyId')

// Both boundaries are inclusive: an assignment is effective ON its start date and ON its end date.
export function isEffectiveOnDate(effectiveFrom: Date, effectiveTo: Date | null, businessDate: Date): boolean {
  if (businessDate.getTime() < effectiveFrom.getTime()) return false
  if (effectiveTo !== null && businessDate.getTime() > effectiveTo.getTime()) return false
  return true
}

// Two periods overlap when they share at least one date. An open end (null) runs forever, so a
// period that ends exactly on another's start date DOES overlap — that shared day is ambiguous.
export function periodsOverlap(
  a: { effectiveFrom: Date; effectiveTo: Date | null },
  b: { effectiveFrom: Date; effectiveTo: Date | null },
): boolean {
  const aEndsBeforeBStarts = a.effectiveTo !== null && a.effectiveTo.getTime() < b.effectiveFrom.getTime()
  const bEndsBeforeAStarts = b.effectiveTo !== null && b.effectiveTo.getTime() < a.effectiveFrom.getTime()
  return !aEndsBeforeBStarts && !bEndsBeforeAStarts
}

export type CreateInput = {
  targetId: string
  effectiveFrom: Date
  effectiveTo: Date | null
}

function suppliedKeys(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return []
  return Object.keys(body as Record<string, unknown>)
}

export function validateCreateBody(body: unknown, kind: AssignmentKind): Outcome<CreateInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'an assignment body is required' }
  const keys = suppliedKeys(body)
  const serverOwned = assignmentServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0)
    return { ok: false, message: `${serverOwned.join(', ')} is derived by the server and cannot be supplied` }

  const target = targetFieldFor(kind)
  const allowed = new Set([target, 'effectiveFrom', 'effectiveTo'])
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  const record = body as Record<string, unknown>
  if (!isAssignmentUuid(record[target])) return { ok: false, message: `${target} must be a UUID` }

  const effectiveFrom = parseStrictDateOnly(record.effectiveFrom)
  if (!effectiveFrom) return { ok: false, message: 'effectiveFrom must be a real calendar date in YYYY-MM-DD format' }

  // A past start date is legitimate: historical assignments may be entered after the fact.
  let effectiveTo: Date | null = null
  if (record.effectiveTo !== undefined && record.effectiveTo !== null) {
    const parsed = parseStrictDateOnly(record.effectiveTo)
    if (!parsed) return { ok: false, message: 'effectiveTo must be a real calendar date in YYYY-MM-DD format, or null' }
    if (parsed.getTime() < effectiveFrom.getTime()) return { ok: false, message: 'effectiveTo must not be before effectiveFrom' }
    effectiveTo = parsed
  }

  return { ok: true, value: { targetId: record[target] as string, effectiveFrom, effectiveTo } }
}

export function validateCloseBody(body: unknown): Outcome<Date> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'a close body is required' }
  const keys = suppliedKeys(body)
  const serverOwned = assignmentServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0) return { ok: false, message: `${serverOwned.join(', ')} cannot be supplied` }
  const unknown = keys.filter((key) => !assignmentCloseFields.includes(key as (typeof assignmentCloseFields)[number]))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  const record = body as Record<string, unknown>
  const effectiveTo = parseStrictDateOnly(record.effectiveTo)
  if (!effectiveTo) return { ok: false, message: 'effectiveTo must be a real calendar date in YYYY-MM-DD format' }
  return { ok: true, value: effectiveTo }
}

export type CloseDecision = { kind: 'close'; effectiveTo: Date } | { kind: 'rejected'; message: string }

// Closing is allowed once, on an open assignment, with a date that does not precede its start.
// There is no reopen, no extend and no shorten: a recorded period is historical truth.
export function decideClose(
  existing: { effectiveFrom: Date; effectiveTo: Date | null },
  effectiveTo: Date,
): CloseDecision {
  if (existing.effectiveTo !== null)
    return { kind: 'rejected', message: 'this assignment is already closed; a closed period cannot be reopened, extended or shortened' }
  if (effectiveTo.getTime() < existing.effectiveFrom.getTime())
    return { kind: 'rejected', message: 'the closing date must not be before effectiveFrom' }
  return { kind: 'close', effectiveTo }
}

export type StoredAssignment = {
  id: string
  clinicianId: string
  effectiveFrom: Date
  effectiveTo: Date | null
  createdAt: Date
  updatedAt: Date
}

export function toFacilityDto(record: StoredAssignment & { facilityId: string }) {
  return {
    id: record.id,
    clinicianId: record.clinicianId,
    facilityId: record.facilityId,
    effectiveFrom: formatDateOnly(record.effectiveFrom) as string,
    effectiveTo: formatDateOnly(record.effectiveTo),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export function toSpecialtyDto(record: StoredAssignment & { specialtyId: string }) {
  return {
    id: record.id,
    clinicianId: record.clinicianId,
    specialtyId: record.specialtyId,
    effectiveFrom: formatDateOnly(record.effectiveFrom) as string,
    effectiveTo: formatDateOnly(record.effectiveTo),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

// The zero/one/many rule, kept pure so the resolvers and their tests share exactly one decision.
export function decideResolution<T extends { id: string }>(matches: T[]) {
  if (matches.length === 0) return { status: 'NO_MATCH' as const }
  if (matches.length === 1) return { status: 'RESOLVED' as const, assignment: matches[0] }
  return { status: 'INTEGRITY_CONFLICT' as const, matchedIds: matches.map((match) => match.id).sort() }
}
