import { Prisma } from '../../../generated/prisma/client.ts'
import { formatDateOnly, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import { isCommercialContextUuid } from '../commercial-coverage/commercial-context.validation.ts'
import {
  createBodyFields,
  observationValueTypes,
  serverOwnedFields,
  type EncounterObservationCreateInput,
  type EncounterObservationDto,
  type ObservationColumns,
  type ObservationValue,
} from './encounter-observation.types.ts'

// A4.7 §13/§18 — the pure rules: the typed discriminated-union create body and the stored-row
// invariant. No database access lives here, and no fact-key vocabulary, value range or unit list is
// hard-coded: A3/A5 governed validation may restrict specific keys later. Nothing is coerced — a
// string 'true', a JSON number, a blank unit or a timestamp is refused, never converted.

export function isEncounterObservationUuid(value: unknown): value is string {
  return typeof value === 'string' && isCommercialContextUuid(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

function isPlainObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
}

function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key))
}

// §9/§13 exact signed decimal: optional leading '-', at most 16 integer digits and 8 decimals (the
// NUMERIC(24,8) column), no exponent, no '+', no leading zeros, no bare point — refused, never
// rounded. Zero and negatives are allowed: A4.7 does not know the fact's domain meaning.
const STRICT_SIGNED_DECIMAL = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/

export function parseObservationDecimal(value: unknown): Outcome<Prisma.Decimal> {
  if (typeof value !== 'string' || !STRICT_SIGNED_DECIMAL.test(value)) {
    return { ok: false, message: 'decimal must be a decimal string with at most 16 digits before and 8 after the decimal point' }
  }
  return { ok: true, value: new Prisma.Decimal(value) }
}

function nonblankString(value: unknown, field: string): Outcome<string> {
  if (typeof value !== 'string') return { ok: false, message: `${field} must be a string` }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: `${field} must not be blank` }
  return { ok: true, value: trimmed }
}

// §6/§13 — the value is a discriminated union on `type`, with exactly that type's keys.
export function validateObservationValue(value: unknown): Outcome<ObservationValue> {
  if (!isPlainObject(value)) return { ok: false, message: 'value must be an object with a type' }
  const type = value.type
  if (typeof type !== 'string' || !(observationValueTypes as readonly string[]).includes(type))
    return { ok: false, message: `value.type must be one of ${observationValueTypes.join(', ')}` }

  if (type === 'TEXT') {
    const extra = unknownKeys(value, ['type', 'text'])
    if (extra.length > 0) return { ok: false, message: `unknown value field(s) for TEXT: ${extra.join(', ')}` }
    const text = nonblankString(value.text, 'value.text')
    if (!text.ok) return text
    return { ok: true, value: { type: 'TEXT', text: text.value } }
  }

  if (type === 'DECIMAL') {
    const extra = unknownKeys(value, ['type', 'decimal', 'unitCode'])
    if (extra.length > 0) return { ok: false, message: `unknown value field(s) for DECIMAL: ${extra.join(', ')}` }
    const decimal = parseObservationDecimal(value.decimal)
    if (!decimal.ok) return decimal
    let unitCode: string | null = null
    if (value.unitCode !== undefined && value.unitCode !== null) {
      const unit = nonblankString(value.unitCode, 'value.unitCode')
      if (!unit.ok) return unit
      unitCode = unit.value
    }
    return { ok: true, value: { type: 'DECIMAL', decimal: decimal.value.toFixed(), unitCode } }
  }

  if (type === 'BOOLEAN') {
    const extra = unknownKeys(value, ['type', 'boolean'])
    if (extra.length > 0) return { ok: false, message: `unknown value field(s) for BOOLEAN: ${extra.join(', ')}` }
    if (typeof value.boolean !== 'boolean') return { ok: false, message: 'value.boolean must be a JSON boolean (true or false)' }
    return { ok: true, value: { type: 'BOOLEAN', boolean: value.boolean } }
  }

  const extra = unknownKeys(value, ['type', 'date'])
  if (extra.length > 0) return { ok: false, message: `unknown value field(s) for DATE: ${extra.join(', ')}` }
  if (!parseStrictDateOnly(value.date)) return { ok: false, message: 'value.date must be a real calendar date in YYYY-MM-DD form' }
  return { ok: true, value: { type: 'DATE', date: value.date as string } }
}

// §13 — create takes exactly { encounterActivityId?, factKey, value }.
export function validateCreateBody(body: unknown): Outcome<EncounterObservationCreateInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'an observation body is required' }
  const keys = Object.keys(body)
  const serverOwned = serverOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0) return { ok: false, message: `${serverOwned.join(', ')} is owned by the server and cannot be supplied` }
  const extra = unknownKeys(body, createBodyFields)
  if (extra.length > 0) return { ok: false, message: `unknown field(s): ${extra.join(', ')}` }

  let encounterActivityId: string | null = null
  if (body.encounterActivityId !== undefined && body.encounterActivityId !== null) {
    if (!isEncounterObservationUuid(body.encounterActivityId)) return { ok: false, message: 'encounterActivityId must be a UUID or null' }
    encounterActivityId = body.encounterActivityId
  }
  const factKey = nonblankString(body.factKey, 'factKey')
  if (!factKey.ok) return factKey
  const value = validateObservationValue(body.value)
  if (!value.ok) return value
  return { ok: true, value: { encounterActivityId, factKey: factKey.value, value: value.value } }
}

// Remove: an empty object (an absent body is treated as empty). Anything else is rejected.
export function validateRemoveBody(body: unknown): Outcome<null> {
  if (body === undefined) return { ok: true, value: null }
  if (!isPlainObject(body)) return { ok: false, message: 'a remove body must be an empty object' }
  if (Object.keys(body).length > 0) return { ok: false, message: `unknown field(s): ${Object.keys(body).join(', ')}` }
  return { ok: true, value: null }
}

// Maps a validated value onto its typed columns: exactly one value column is populated.
export function toObservationColumns(factKey: string, value: ObservationValue): ObservationColumns {
  const empty = { valueText: null, valueDecimal: null, valueBoolean: null, valueDate: null, unitCode: null }
  if (value.type === 'TEXT') return { factKey, valueType: 'TEXT', ...empty, valueText: value.text }
  if (value.type === 'DECIMAL') return { factKey, valueType: 'DECIMAL', ...empty, valueDecimal: new Prisma.Decimal(value.decimal), unitCode: value.unitCode }
  if (value.type === 'BOOLEAN') return { factKey, valueType: 'BOOLEAN', ...empty, valueBoolean: value.boolean }
  return { factKey, valueType: 'DATE', ...empty, valueDate: parseStrictDateOnly(value.date) }
}

export type StoredObservation = {
  encounterId: string
  encounterActivityId: string | null
  // The anchored activity's own encounterId, read alongside the row (null when unanchored).
  activityEncounterId: string | null
  factKey: string
  valueType: string
  valueText: string | null
  valueDecimal: Prisma.Decimal | null
  valueBoolean: boolean | null
  valueDate: Date | null
  unitCode: string | null
}

const blank = (text: string | null) => text !== null && text.trim() === ''

// §18 — the stored typed-value invariant, re-checked on every read as a second line of defence
// behind the database CHECKs. A violation is reported, never repaired.
export function verifyStoredObservation(row: StoredObservation): Outcome<ObservationValue> {
  const conflict = (message: string): Outcome<ObservationValue> => ({ ok: false, message: `stored observation is invalid: ${message}` })
  if (row.factKey.trim() === '') return conflict('blank factKey')
  if (blank(row.valueText)) return conflict('blank text value')
  if (blank(row.unitCode)) return conflict('blank unit')
  if (row.encounterActivityId !== null && row.activityEncounterId !== row.encounterId) return conflict('the anchored activity belongs to another encounter')

  const populated = [row.valueText, row.valueDecimal, row.valueBoolean, row.valueDate].filter((column) => column !== null).length
  if (populated !== 1) return conflict('exactly one typed value column must be populated')
  if (row.unitCode !== null && row.valueType !== 'DECIMAL') return conflict('a unit is only allowed with a DECIMAL value')

  if (row.valueType === 'TEXT' && row.valueText !== null) return { ok: true, value: { type: 'TEXT', text: row.valueText } }
  if (row.valueType === 'DECIMAL' && row.valueDecimal !== null)
    return { ok: true, value: { type: 'DECIMAL', decimal: row.valueDecimal.toFixed(), unitCode: row.unitCode } }
  if (row.valueType === 'BOOLEAN' && typeof row.valueBoolean === 'boolean') return { ok: true, value: { type: 'BOOLEAN', boolean: row.valueBoolean } }
  if (row.valueType === 'DATE' && row.valueDate !== null) {
    const date = formatDateOnly(row.valueDate)
    if (date) return { ok: true, value: { type: 'DATE', date } }
  }
  return conflict(`value type ${JSON.stringify(row.valueType)} does not match its populated column`)
}

// Builds the DTO from a row whose value already passed verifyStoredObservation.
export function toEncounterObservationDto(
  record: { id: string; encounterId: string; encounterActivityId: string | null; factKey: string; removedAt: Date | null; createdAt: Date; updatedAt: Date },
  value: ObservationValue,
): EncounterObservationDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    encounterActivityId: record.encounterActivityId,
    factKey: record.factKey,
    value,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
