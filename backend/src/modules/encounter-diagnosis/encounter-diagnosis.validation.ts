import { isCommercialContextUuid } from '../commercial-coverage/commercial-context.validation.ts'
import { addBodyFields, orderBodyFields, serverOwnedFields, type EncounterDiagnosisDto } from './encounter-diagnosis.types.ts'

// A4.5 §19/§22 — the pure rules: body validation, the read invariant (active rows must be a
// contiguous 1..N with unique codes) and the reorder plan. No database access lives here.

export function isEncounterDiagnosisUuid(value: unknown): value is string {
  return typeof value === 'string' && isCommercialContextUuid(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

function isPlainObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
}

function refuseForeignKeys(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const keys = Object.keys(body)
  const serverOwned = serverOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0) return `${serverOwned.join(', ')} is owned by the server and cannot be supplied`
  const unknown = keys.filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(', ')}`
  return null
}

// Add: exactly { diagnosisCodeId }. The sequence is always appended by the server.
export function validateAddBody(body: unknown): Outcome<{ diagnosisCodeId: string }> {
  if (!isPlainObject(body)) return { ok: false, message: 'a diagnosis body is required' }
  const refused = refuseForeignKeys(body, addBodyFields)
  if (refused) return { ok: false, message: refused }
  if (!isEncounterDiagnosisUuid(body.diagnosisCodeId)) return { ok: false, message: 'diagnosisCodeId is required and must be a UUID' }
  return { ok: true, value: { diagnosisCodeId: body.diagnosisCodeId } }
}

// Reorder: exactly { encounterDiagnosisIds: [uuid, ...] } with no duplicates. Whether the list is
// the exact active set is decided by planReorder against the locked state.
export function validateOrderBody(body: unknown): Outcome<string[]> {
  if (!isPlainObject(body)) return { ok: false, message: 'an order body is required' }
  const refused = refuseForeignKeys(body, orderBodyFields)
  if (refused) return { ok: false, message: refused }
  const ids = body.encounterDiagnosisIds
  if (!Array.isArray(ids)) return { ok: false, message: 'encounterDiagnosisIds must be an array' }
  if (!ids.every(isEncounterDiagnosisUuid)) return { ok: false, message: 'encounterDiagnosisIds must contain UUIDs only' }
  if (new Set(ids).size !== ids.length) return { ok: false, message: 'encounterDiagnosisIds must not contain duplicates' }
  return { ok: true, value: ids as string[] }
}

// Remove: an empty object (an absent body is treated as empty). Anything else is rejected.
export function validateRemoveBody(body: unknown): Outcome<null> {
  if (body === undefined) return { ok: true, value: null }
  if (!isPlainObject(body)) return { ok: false, message: 'a remove body must be an empty object' }
  const refused = refuseForeignKeys(body, [])
  if (refused) return { ok: false, message: refused }
  return { ok: true, value: null }
}

export type ActiveRow = { id: string; diagnosisCodeId: string; sequence: number }

// §22 — active rows ordered by sequence must be exactly 1..N with unique DiagnosisCodes. A stored
// violation is reported, never repaired: readers and writers fail closed on it.
export function checkReadInvariant(rows: ActiveRow[]): Outcome<ActiveRow[]> {
  const sorted = [...rows].sort((a, b) => a.sequence - b.sequence)
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].sequence !== index + 1)
      return { ok: false, message: 'stored active diagnosis order is not a contiguous 1..N sequence' }
  }
  if (new Set(sorted.map((row) => row.diagnosisCodeId)).size !== sorted.length)
    return { ok: false, message: 'stored active diagnoses contain the same DiagnosisCode more than once' }
  return { ok: true, value: sorted }
}

export type SequenceChange = { id: string; from: number; to: number }

// §16 — the requested list must be the exact active set, each ID once, in a new order. Returns the
// rows whose sequence changes; an identical order is a no-op and is refused.
export function planReorder(active: ActiveRow[], requestedIds: string[]): Outcome<SequenceChange[]> {
  if (active.length === 0 && requestedIds.length === 0) return { ok: false, message: 'there are no active diagnoses to reorder' }
  const activeIds = new Set(active.map((row) => row.id))
  if (requestedIds.length !== active.length || !requestedIds.every((id) => activeIds.has(id)))
    return { ok: false, message: 'encounterDiagnosisIds must list every active diagnosis of this encounter exactly once' }
  const current = new Map(active.map((row) => [row.id, row.sequence]))
  const changes = requestedIds
    .map((id, index) => ({ id, from: current.get(id) as number, to: index + 1 }))
    .filter((change) => change.from !== change.to)
  if (changes.length === 0) return { ok: false, message: 'the requested order is the same as the current order' }
  return { ok: true, value: changes }
}

// §17 — after a removal, the remaining active rows (already ordered) are renumbered 1..N.
export function planCompaction(remaining: ActiveRow[]): SequenceChange[] {
  return [...remaining]
    .sort((a, b) => a.sequence - b.sequence)
    .map((row, index) => ({ id: row.id, from: row.sequence, to: index + 1 }))
    .filter((change) => change.from !== change.to)
}

export function toEncounterDiagnosisDto(record: {
  id: string
  encounterId: string
  diagnosisCodeId: string
  sequence: number
  createdAt: Date
  updatedAt: Date
  diagnosisCode: { code: string; displayName: string }
}): EncounterDiagnosisDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    diagnosisCodeId: record.diagnosisCodeId,
    sequence: record.sequence,
    diagnosisCode: { code: record.diagnosisCode.code, displayName: record.diagnosisCode.displayName },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
