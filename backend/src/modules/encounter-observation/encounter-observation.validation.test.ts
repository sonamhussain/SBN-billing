import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '../../../generated/prisma/client.ts'
import {
  isEncounterObservationUuid,
  parseObservationDecimal,
  toEncounterObservationDto,
  toObservationColumns,
  validateCreateBody,
  validateObservationValue,
  validateRemoveBody,
  verifyStoredObservation,
  type StoredObservation,
} from './encounter-observation.validation.ts'
import { encounterObservationAuditSnapshot } from '../audit/audit.snapshot.ts'

// A4.7 — the pure typed-value, create-body and stored-row rules. Synthetic values only.

const OBS = '11111111-1111-4111-8111-111111111111'
const ENC = '22222222-2222-4222-8222-222222222222'
const ACT = '33333333-3333-4333-8333-333333333333'
const OTHER_ENC = '44444444-4444-4444-8444-444444444444'

test('an encounter observation id must be UUID-shaped', () => {
  assert.equal(isEncounterObservationUuid(OBS), true)
  assert.equal(isEncounterObservationUuid('nope'), false)
  assert.equal(isEncounterObservationUuid(7), false)
})

test('TEXT is trimmed and nonblank, with no other keys', () => {
  assert.deepEqual(validateObservationValue({ type: 'TEXT', text: '  Synthetic note ' }), { ok: true, value: { type: 'TEXT', text: 'Synthetic note' } })
  for (const value of [{ type: 'TEXT', text: '   ' }, { type: 'TEXT', text: 5 }, { type: 'TEXT' }, { type: 'TEXT', text: 'x', unitCode: 'cm' }, { type: 'TEXT', text: 'x', extra: 1 }]) {
    assert.equal(validateObservationValue(value).ok, false, JSON.stringify(value))
  }
})

test('DECIMAL is an exact signed string: zero and negatives allowed, up to 16 + 8 digits, canonical form', () => {
  for (const [input, canonical] of [['0', '0'], ['-12.5', '-12.5'], ['175.50000000', '175.5'], ['0.00000001', '0.00000001'], ['9999999999999999.99999999', '9999999999999999.99999999'], ['-0', '0']]) {
    const outcome = parseObservationDecimal(input)
    assert.equal(outcome.ok, true, input)
    if (outcome.ok) assert.equal(outcome.value.toFixed(), canonical, input)
  }
})

test('DECIMAL refuses exponents, over-precision, oversize, signs, padding and JSON numbers — never rounding', () => {
  for (const input of ['1e3', '1E-2', '0.000000001', '10000000000000000', '+1', '01', '.5', '5.', '', ' 1', '1 ', '1,5', 'NaN', 'Infinity', '--1']) {
    assert.equal(parseObservationDecimal(input).ok, false, JSON.stringify(input))
  }
  for (const input of [1, 12.5, null, undefined, true, {}]) assert.equal(parseObservationDecimal(input).ok, false, JSON.stringify(input))
})

test('DECIMAL unit is optional, trimmed with case kept, never blank', () => {
  assert.deepEqual(validateObservationValue({ type: 'DECIMAL', decimal: '1' }), { ok: true, value: { type: 'DECIMAL', decimal: '1', unitCode: null } })
  assert.deepEqual(validateObservationValue({ type: 'DECIMAL', decimal: '1', unitCode: null }), { ok: true, value: { type: 'DECIMAL', decimal: '1', unitCode: null } })
  assert.deepEqual(validateObservationValue({ type: 'DECIMAL', decimal: '1', unitCode: '  cM ' }), { ok: true, value: { type: 'DECIMAL', decimal: '1', unitCode: 'cM' } })
  for (const unitCode of ['', '   ', 5]) assert.equal(validateObservationValue({ type: 'DECIMAL', decimal: '1', unitCode }).ok, false, JSON.stringify(unitCode))
})

test('BOOLEAN accepts only a real JSON boolean', () => {
  assert.deepEqual(validateObservationValue({ type: 'BOOLEAN', boolean: true }), { ok: true, value: { type: 'BOOLEAN', boolean: true } })
  assert.deepEqual(validateObservationValue({ type: 'BOOLEAN', boolean: false }), { ok: true, value: { type: 'BOOLEAN', boolean: false } })
  for (const boolean of ['true', 'false', 1, 0, null, undefined]) assert.equal(validateObservationValue({ type: 'BOOLEAN', boolean }).ok, false, JSON.stringify(boolean))
})

test('DATE accepts only a real YYYY-MM-DD calendar day, past or future', () => {
  for (const date of ['2024-02-29', '2099-12-31', '1900-01-01']) assert.equal(validateObservationValue({ type: 'DATE', date }).ok, true, date)
  for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-01-01T00:00:00.000Z', '26-01-01', '2026/01/01', 20260101, null]) {
    assert.equal(validateObservationValue({ type: 'DATE', date }).ok, false, JSON.stringify(date))
  }
})

test('the value type is a closed list — no CODE, JSON, list or expression', () => {
  for (const value of [null, [], 'TEXT', {}, { type: 'CODE', code: 'x' }, { type: 'JSON', json: {} }, { type: 'text', text: 'x' }, { type: 'EXPRESSION', expression: 'a > b' }]) {
    assert.equal(validateObservationValue(value).ok, false, JSON.stringify(value))
  }
})

test('a create body is exactly { encounterActivityId?, factKey, value }; factKey is trimmed with case kept', () => {
  const outcome = validateCreateBody({ factKey: '  Synthetic_Key ', value: { type: 'BOOLEAN', boolean: true } })
  assert.deepEqual(outcome, { ok: true, value: { encounterActivityId: null, factKey: 'Synthetic_Key', value: { type: 'BOOLEAN', boolean: true } } })
  assert.equal(validateCreateBody({ encounterActivityId: ACT, factKey: 'K', value: { type: 'TEXT', text: 'x' } }).ok, true)
  assert.equal(validateCreateBody({ encounterActivityId: null, factKey: 'K', value: { type: 'TEXT', text: 'x' } }).ok, true)
  for (const body of [null, [], { factKey: '  ', value: { type: 'TEXT', text: 'x' } }, { factKey: 5, value: { type: 'TEXT', text: 'x' } }, { factKey: 'K' }, { factKey: 'K', value: { type: 'TEXT', text: 'x' }, encounterActivityId: 'x' }]) {
    assert.equal(validateCreateBody(body).ok, false, JSON.stringify(body))
  }
  for (const field of ['id', 'encounterId', 'removedAt', 'createdAt', 'updatedAt']) {
    const refused = validateCreateBody({ factKey: 'K', value: { type: 'TEXT', text: 'x' }, [field]: 'x' })
    assert.equal(refused.ok, false, field)
    if (!refused.ok) assert.match(refused.message, new RegExp(field))
  }
  for (const field of ['operator', 'expression', 'condition', 'valueType', 'organizationId', 'sequence']) {
    assert.equal(validateCreateBody({ factKey: 'K', value: { type: 'TEXT', text: 'x' }, [field]: 'x' }).ok, false, field)
  }
})

test('the remove body is empty (or absent); anything else is rejected', () => {
  assert.equal(validateRemoveBody(undefined).ok, true)
  assert.equal(validateRemoveBody({}).ok, true)
  for (const body of [null, [], { reason: 'x' }, { removedAt: '2026-01-01' }]) assert.equal(validateRemoveBody(body).ok, false, JSON.stringify(body))
})

test('each value populates exactly one typed column; a unit only accompanies DECIMAL', () => {
  const text = toObservationColumns('K', { type: 'TEXT', text: 'x' })
  assert.equal(text.valueType === 'TEXT' && text.valueText === 'x' && text.valueDecimal === null && text.unitCode === null, true)
  const decimal = toObservationColumns('K', { type: 'DECIMAL', decimal: '-1.25', unitCode: 'cm' })
  assert.equal(decimal.valueDecimal instanceof Prisma.Decimal && decimal.valueDecimal.toFixed() === '-1.25' && decimal.unitCode === 'cm' && decimal.valueText === null, true)
  const bool = toObservationColumns('K', { type: 'BOOLEAN', boolean: false })
  assert.equal(bool.valueBoolean === false && bool.valueDate === null, true)
  const date = toObservationColumns('K', { type: 'DATE', date: '2024-02-29' })
  assert.equal(date.valueDate?.toISOString(), '2024-02-29T00:00:00.000Z')
})

const stored = (overrides: Partial<StoredObservation>): StoredObservation => ({
  encounterId: ENC,
  encounterActivityId: null,
  activityEncounterId: null,
  factKey: 'K',
  valueType: 'TEXT',
  valueText: 'x',
  valueDecimal: null,
  valueBoolean: null,
  valueDate: null,
  unitCode: null,
  ...overrides,
})

test('a valid stored row of each type reads back as its typed value', () => {
  assert.deepEqual(verifyStoredObservation(stored({})), { ok: true, value: { type: 'TEXT', text: 'x' } })
  assert.deepEqual(verifyStoredObservation(stored({ valueType: 'DECIMAL', valueText: null, valueDecimal: new Prisma.Decimal('175.50000000'), unitCode: 'cm' })), {
    ok: true,
    value: { type: 'DECIMAL', decimal: '175.5', unitCode: 'cm' },
  })
  assert.deepEqual(verifyStoredObservation(stored({ valueType: 'BOOLEAN', valueText: null, valueBoolean: false })), { ok: true, value: { type: 'BOOLEAN', boolean: false } })
  assert.deepEqual(verifyStoredObservation(stored({ valueType: 'DATE', valueText: null, valueDate: new Date('2024-02-29T00:00:00.000Z') })), {
    ok: true,
    value: { type: 'DATE', date: '2024-02-29' },
  })
  assert.equal(verifyStoredObservation(stored({ encounterActivityId: ACT, activityEncounterId: ENC })).ok, true)
})

test('a stored row that breaks the typed-value invariant fails closed', () => {
  const corrupt: [string, Partial<StoredObservation>][] = [
    ['unknown value type', { valueType: 'CODE' }],
    ['lower-case value type', { valueType: 'text' }],
    ['type/column mismatch', { valueType: 'DECIMAL' }],
    ['two typed columns', { valueBoolean: true }],
    ['no typed column', { valueText: null }],
    ['blank text', { valueText: '   ' }],
    ['blank unit', { valueType: 'DECIMAL', valueText: null, valueDecimal: new Prisma.Decimal('1'), unitCode: ' ' }],
    ['unit on TEXT', { unitCode: 'cm' }],
    ['blank factKey', { factKey: '  ' }],
    ['activity of another encounter', { encounterActivityId: ACT, activityEncounterId: OTHER_ENC }],
  ]
  for (const [label, overrides] of corrupt) assert.equal(verifyStoredObservation(stored(overrides)).ok, false, label)
})

test('the DTO carries the typed value and anchors, never context or executable fields', () => {
  const dto = toEncounterObservationDto(
    { id: OBS, encounterId: ENC, encounterActivityId: ACT, factKey: 'K', removedAt: null, createdAt: new Date('2026-09-25T10:00:00.000Z'), updatedAt: new Date('2026-09-25T10:00:00.000Z') },
    { type: 'DECIMAL', decimal: '1.5', unitCode: null },
  )
  assert.deepEqual(dto.value, { type: 'DECIMAL', decimal: '1.5', unitCode: null })
  assert.equal(typeof dto.value.type === 'string' && dto.removedAt === null, true)
  assert.equal(Object.keys(dto).some((key) => /(patient|organization|payer|claim|price|operator|expression|condition|evidence)/i.test(key)), false)
})

test('the audit snapshot carries only id, removedAt and updatedAt — never the fact or its anchors', () => {
  const snapshot = encounterObservationAuditSnapshot({ id: OBS, removedAt: null, updatedAt: new Date('2026-09-25T10:00:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['id', 'removedAt', 'updatedAt'])
  assert.deepEqual(Object.keys(encounterObservationAuditSnapshot({ id: OBS })), ['id'])
  const text = JSON.stringify(snapshot)
  for (const value of [ENC, ACT, 'K', '1.5']) assert.equal(text.includes(value), false, value)
})
