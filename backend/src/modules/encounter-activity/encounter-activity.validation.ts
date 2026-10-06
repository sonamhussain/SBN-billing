import { Prisma } from '../../../generated/prisma/client.ts'
import { isCommercialContextUuid } from '../commercial-coverage/commercial-context.validation.ts'
import { createBodyFields, serverOwnedFields, type EncounterActivityCreateInput, type EncounterActivityDto } from './encounter-activity.types.ts'

// A4.6 §16–§17/§21 — the pure rules: create-body validation (identity, exact quantity, opaque unit
// and ordered modifiers) and the stored-modifier invariant. No database access lives here, and no
// unit or modifier vocabulary is hard-coded: codes are opaque and validated by governed rules later.

export function isEncounterActivityUuid(value: unknown): value is string {
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

// §17 strict decimal: no sign, exponent, leading zeros or bare point; at most 4 decimal places (the
// column scale — more is refused, never rounded) and at most 14 integer digits (the rest of the
// NUMERIC(18,4) precision), so an oversized value is a validation error instead of a database error.
const STRICT_DECIMAL = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/

export function parsePositiveQuantity(value: unknown): Outcome<Prisma.Decimal> {
  if (typeof value !== 'string' || !STRICT_DECIMAL.test(value.trim())) {
    return { ok: false, message: 'quantity must be a positive decimal string with at most 14 digits before and 4 after the decimal point' }
  }
  const quantity = new Prisma.Decimal(value.trim())
  if (quantity.lte(0)) return { ok: false, message: 'quantity must be greater than zero' }
  return { ok: true, value: quantity }
}

// Optional master reference: absent or null means "not supplied"; anything else must be a UUID.
function optionalUuid(value: unknown, field: string): Outcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isEncounterActivityUuid(value)) return { ok: false, message: `${field} must be a UUID or null` }
  return { ok: true, value }
}

// Optional opaque unit: absent or null means none; a supplied value is trimmed and must be nonblank.
// A blank string is refused rather than silently turned into null.
export function normalizeUnitCode(value: unknown): Outcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: 'unitCode must be a string or null' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: 'unitCode must not be blank; omit it or send null when there is no unit' }
  return { ok: true, value: trimmed }
}

// §9 ordered opaque modifiers: absent or null means none. Each code is trimmed (case is kept), must
// be a nonblank string and may appear once. Supplied order is preserved; no maximum count is imposed.
export function normalizeModifierCodes(value: unknown): Outcome<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, message: 'modifierCodes must be an array of strings' }
  const codes: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, message: 'modifierCodes must contain strings only' }
    const trimmed = item.trim()
    if (trimmed === '') return { ok: false, message: 'modifierCodes must not contain a blank code' }
    codes.push(trimmed)
  }
  if (new Set(codes).size !== codes.length) return { ok: false, message: 'modifierCodes must not contain the same code twice' }
  return { ok: true, value: codes }
}

// §16 — create takes only the five client fields; at least one of serviceId/procedureCodeId.
export function validateCreateBody(body: unknown): Outcome<EncounterActivityCreateInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'an activity body is required' }
  const refused = refuseForeignKeys(body, createBodyFields)
  if (refused) return { ok: false, message: refused }

  const serviceId = optionalUuid(body.serviceId, 'serviceId')
  if (!serviceId.ok) return serviceId
  const procedureCodeId = optionalUuid(body.procedureCodeId, 'procedureCodeId')
  if (!procedureCodeId.ok) return procedureCodeId
  if (serviceId.value === null && procedureCodeId.value === null)
    return { ok: false, message: 'an activity needs a serviceId, a procedureCodeId or both' }

  const quantity = parsePositiveQuantity(body.quantity)
  if (!quantity.ok) return quantity
  const unitCode = normalizeUnitCode(body.unitCode)
  if (!unitCode.ok) return unitCode
  const modifierCodes = normalizeModifierCodes(body.modifierCodes)
  if (!modifierCodes.ok) return modifierCodes

  return {
    ok: true,
    value: { serviceId: serviceId.value, procedureCodeId: procedureCodeId.value, quantity: quantity.value, unitCode: unitCode.value, modifierCodes: modifierCodes.value },
  }
}

// Remove: an empty object (an absent body is treated as empty). Anything else is rejected.
export function validateRemoveBody(body: unknown): Outcome<null> {
  if (body === undefined) return { ok: true, value: null }
  if (!isPlainObject(body)) return { ok: false, message: 'a remove body must be an empty object' }
  const refused = refuseForeignKeys(body, [])
  if (refused) return { ok: false, message: refused }
  return { ok: true, value: null }
}

export type StoredModifier = { sequence: number; code: string }

// §21 — stored modifiers ordered by sequence must be exactly 1..N with nonblank, unique codes. A
// violation is reported, never repaired: every reader fails closed on it.
export function checkModifierInvariant(modifiers: StoredModifier[]): Outcome<string[]> {
  const sorted = [...modifiers].sort((a, b) => a.sequence - b.sequence)
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].sequence !== index + 1)
      return { ok: false, message: 'stored modifier order is not a contiguous 1..N sequence' }
    if (sorted[index].code.trim() === '') return { ok: false, message: 'a stored modifier code is blank' }
  }
  if (new Set(sorted.map((modifier) => modifier.code)).size !== sorted.length)
    return { ok: false, message: 'stored modifiers contain the same code more than once' }
  return { ok: true, value: sorted.map((modifier) => modifier.code) }
}

// Builds the DTO from a row whose modifiers already passed checkModifierInvariant.
export function toEncounterActivityDto(
  record: {
    id: string
    encounterId: string
    serviceId: string | null
    procedureCodeId: string | null
    quantity: Prisma.Decimal
    unitCode: string | null
    removedAt: Date | null
    createdAt: Date
    updatedAt: Date
  },
  modifierCodes: string[],
): EncounterActivityDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    serviceId: record.serviceId,
    procedureCodeId: record.procedureCodeId,
    quantity: record.quantity.toFixed(),
    unitCode: record.unitCode,
    modifierCodes,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
