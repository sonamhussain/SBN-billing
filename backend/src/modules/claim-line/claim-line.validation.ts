import { isClaimUuid } from '../claim/claim.validation.ts'
import { createLineBodyFields, orderLineBodyFields, pointerBodyFields, serverOwnedLineFields } from './claim-line.types.ts'

// A6.2 — the pure rules shared by ClaimLine and ClaimDiagnosis writers: body shapes, the active-order
// invariant, the reorder and compaction plans and the exact-set pointer plan. No database access lives
// here.

export const isClaimStructureUuid = (value: unknown): value is string => isClaimUuid(value)

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

export function isPlainObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
}

// A forged server-owned field is named as such; any other unexpected field is refused by name, never by
// value.
export function refuseForeignKeys(body: Record<string, unknown>, allowed: readonly string[], serverOwned: readonly string[]): string | null {
  const keys = Object.keys(body)
  const forged = serverOwned.filter((field) => keys.includes(field))
  if (forged.length > 0) return `${forged.join(', ')} is owned by the server and cannot be supplied`
  const unknown = keys.filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(', ')}`
  return null
}

// §9 — create: exactly { encounterActivityId }. The position, contract, creator and timestamps are the
// server's; service, procedure, quantity, unit and modifiers are A4.6 facts and are never accepted.
export function validateCreateLineBody(body: unknown): Outcome<{ encounterActivityId: string }> {
  if (!isPlainObject(body)) return { ok: false, message: 'a claim line body is required' }
  const refused = refuseForeignKeys(body, createLineBodyFields, serverOwnedLineFields)
  if (refused) return { ok: false, message: refused }
  if (!isClaimStructureUuid(body.encounterActivityId)) return { ok: false, message: 'encounterActivityId is required and must be a UUID' }
  return { ok: true, value: { encounterActivityId: body.encounterActivityId } }
}

// An id list: UUIDs only and no duplicates. Whether it is the exact active set is decided against the
// locked state, never here.
export function validateIdList(body: unknown, field: string, allowed: readonly string[], serverOwned: readonly string[]): Outcome<string[]> {
  if (!isPlainObject(body)) return { ok: false, message: `a { ${field} } body is required` }
  const refused = refuseForeignKeys(body, allowed, serverOwned)
  if (refused) return { ok: false, message: refused }
  const ids = body[field]
  if (!Array.isArray(ids)) return { ok: false, message: `${field} must be an array` }
  if (!ids.every(isClaimStructureUuid)) return { ok: false, message: `${field} must contain UUIDs only` }
  if (new Set(ids).size !== ids.length) return { ok: false, message: `${field} must not contain duplicates` }
  return { ok: true, value: ids as string[] }
}

export const validateLineOrderBody = (body: unknown) => validateIdList(body, 'claimLineIds', orderLineBodyFields, serverOwnedLineFields)

// §11 — the pointer PUT lists the ACTIVE ClaimDiagnosis ids this line should point to. An empty list is
// allowed; a duplicate id is refused rather than silently normalized.
export const validatePointerBody = (body: unknown) => validateIdList(body, 'claimDiagnosisIds', pointerBodyFields, ['claimLineId', 'removedAt', 'createdByUserId', 'createdAt', 'updatedAt'])

// Remove: an empty object (an absent body is treated as empty). Anything else is rejected by name.
export function validateRemoveBody(body: unknown): Outcome<null> {
  if (body === undefined || body === null) return { ok: true, value: null }
  if (!isPlainObject(body)) return { ok: false, message: 'a remove body must be an empty object' }
  const keys = Object.keys(body)
  return keys.length === 0 ? { ok: true, value: null } : { ok: false, message: `field(s) not accepted for removal: ${keys.join(', ')}` }
}

export type PositionedRow = { id: string; sequence: number }

// Active rows ordered by sequence must be exactly 1..N. A stored violation is reported, never repaired:
// readers and writers fail closed on it.
export function checkActiveOrder<T extends PositionedRow>(rows: T[]): Outcome<T[]> {
  const sorted = [...rows].sort((a, b) => a.sequence - b.sequence)
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].sequence !== index + 1) return { ok: false, message: 'stored active order is not a contiguous 1..N sequence' }
  }
  return { ok: true, value: sorted }
}

export type SequenceChange = { id: string; from: number; to: number }

// §9/§10 — the requested list must be the exact active set, each id once. Returns only the rows whose
// position changes; an identical order is an empty plan (a no-op with no write and no audit).
export function planReorder(active: PositionedRow[], requestedIds: string[], label: string): Outcome<SequenceChange[]> {
  const activeIds = new Set(active.map((row) => row.id))
  if (requestedIds.length !== active.length || !requestedIds.every((id) => activeIds.has(id)))
    return { ok: false, message: `${label} must list every active entry of this claim exactly once` }
  const current = new Map(active.map((row) => [row.id, row.sequence]))
  return {
    ok: true,
    value: requestedIds.map((id, index) => ({ id, from: current.get(id) as number, to: index + 1 })).filter((change) => change.from !== change.to),
  }
}

// After a removal the remaining active rows are renumbered 1..N in their existing order.
export function planCompaction(remaining: PositionedRow[]): SequenceChange[] {
  return [...remaining]
    .sort((a, b) => a.sequence - b.sequence)
    .map((row, index) => ({ id: row.id, from: row.sequence, to: index + 1 }))
    .filter((change) => change.from !== change.to)
}

// §11 — exact-set semantics. Active pointers whose diagnosis is absent from the request are removed;
// requested diagnoses without an active pointer are added. Identical sets give an empty plan.
export function planPointerChanges(
  activePointers: { id: string; claimDiagnosisId: string }[],
  requestedDiagnosisIds: string[],
): { removePointerIds: string[]; addDiagnosisIds: string[] } {
  const requested = new Set(requestedDiagnosisIds)
  const current = new Set(activePointers.map((pointer) => pointer.claimDiagnosisId))
  return {
    removePointerIds: activePointers.filter((pointer) => !requested.has(pointer.claimDiagnosisId)).map((pointer) => pointer.id),
    addDiagnosisIds: requestedDiagnosisIds.filter((id) => !current.has(id)),
  }
}
