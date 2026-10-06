import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '../../../generated/prisma/client.ts'
import {
  checkModifierInvariant,
  isEncounterActivityUuid,
  normalizeModifierCodes,
  normalizeUnitCode,
  parsePositiveQuantity,
  toEncounterActivityDto,
  validateCreateBody,
  validateRemoveBody,
} from './encounter-activity.validation.ts'
import { encounterActivityAuditSnapshot } from '../audit/audit.snapshot.ts'

// A4.6 — the pure body, exact-quantity, opaque unit/modifier and stored-modifier rules. Synthetic
// values only.

const EA = '11111111-1111-4111-8111-111111111111'
const ENC = '22222222-2222-4222-8222-222222222222'
const SVC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('an encounter activity id must be UUID-shaped', () => {
  assert.equal(isEncounterActivityUuid(EA), true)
  assert.equal(isEncounterActivityUuid('nope'), false)
  assert.equal(isEncounterActivityUuid(1), false)
})

test('quantity is an exact positive decimal string: integers, decimals and up to 4 places', () => {
  for (const [input, canonical] of [['1', '1'], ['2.5', '2.5'], ['0.125', '0.125'], ['0.0001', '0.0001'], ['12.3400', '12.34'], ['99999999999999.9999', '99999999999999.9999']]) {
    const outcome = parsePositiveQuantity(input)
    assert.equal(outcome.ok, true, input)
    if (outcome.ok) assert.equal(outcome.value.toFixed(), canonical, input)
  }
})

test('quantity refuses zero, negatives, exponents, over-precision, oversize, blanks and non-strings — never rounding', () => {
  for (const input of ['0', '0.0', '0.0000', '-1', '-0.5', '1e3', '1E3', 'NaN', 'Infinity', '2.50001', '0.00001', '100000000000000', '', '   ', '.5', '5.', '01', '+1', '1,5', '1 000']) {
    assert.equal(parsePositiveQuantity(input).ok, false, JSON.stringify(input))
  }
  for (const input of [1, 2.5, null, undefined, {}, [], true]) assert.equal(parsePositiveQuantity(input).ok, false, JSON.stringify(input))
})

test('unitCode is optional and opaque: trimmed, case kept, never blank', () => {
  assert.deepEqual(normalizeUnitCode(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeUnitCode(null), { ok: true, value: null })
  assert.deepEqual(normalizeUnitCode('  Unit-x '), { ok: true, value: 'Unit-x' })
  for (const input of ['', '   ', 5, [], {}]) assert.equal(normalizeUnitCode(input).ok, false, JSON.stringify(input))
})

test('modifierCodes keep supplied order, trim without changing case, refuse blanks, non-strings and duplicates', () => {
  assert.deepEqual(normalizeModifierCodes(undefined), { ok: true, value: [] })
  assert.deepEqual(normalizeModifierCodes(null), { ok: true, value: [] })
  assert.deepEqual(normalizeModifierCodes([' m2', 'M1 ', 'x']), { ok: true, value: ['m2', 'M1', 'x'] })
  for (const input of ['M1', {}, ['M1', ''], ['M1', '  '], ['M1', 2], ['M1', null], ['M1', 'M1'], ['M1', ' M1 ']]) {
    assert.equal(normalizeModifierCodes(input).ok, false, JSON.stringify(input))
  }
  // Exact comparison: codes that differ only by case are distinct opaque values.
  assert.equal(normalizeModifierCodes(['m1', 'M1']).ok, true)
  // No arbitrary maximum count is imposed in core.
  const many = Array.from({ length: 60 }, (_, index) => `MOD${index}`)
  assert.deepEqual(normalizeModifierCodes(many), { ok: true, value: many })
})

test('a create body needs a Service, a ProcedureCode or both — never neither', () => {
  for (const identity of [{ serviceId: SVC }, { procedureCodeId: PROC }, { serviceId: SVC, procedureCodeId: PROC }, { serviceId: SVC, procedureCodeId: null }]) {
    assert.equal(validateCreateBody({ ...identity, quantity: '1' }).ok, true, JSON.stringify(identity))
  }
  for (const identity of [{}, { serviceId: null, procedureCodeId: null }, { serviceId: 'x' }, { procedureCodeId: 7 }]) {
    assert.equal(validateCreateBody({ ...identity, quantity: '1' }).ok, false, JSON.stringify(identity))
  }
})

test('a valid create body normalizes every field', () => {
  const outcome = validateCreateBody({ serviceId: SVC, procedureCodeId: PROC, quantity: ' 2.5 ', unitCode: ' UNIT ', modifierCodes: [' M1', 'M2 '] })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.value.quantity instanceof Prisma.Decimal, true)
  assert.equal(outcome.value.quantity.toFixed(), '2.5')
  assert.equal(outcome.value.unitCode, 'UNIT')
  assert.deepEqual(outcome.value.modifierCodes, ['M1', 'M2'])
  const minimal = validateCreateBody({ procedureCodeId: PROC, quantity: '1' })
  assert.equal(minimal.ok && minimal.value.serviceId === null && minimal.value.unitCode === null && minimal.value.modifierCodes.length === 0, true)
})

test('a create body refuses server-owned and unknown fields, naming them', () => {
  for (const field of ['id', 'encounterId', 'removedAt', 'createdAt', 'updatedAt']) {
    const outcome = validateCreateBody({ serviceId: SVC, quantity: '1', [field]: 'x' })
    assert.equal(outcome.ok, false, field)
    if (!outcome.ok) assert.match(outcome.message, new RegExp(field))
  }
  for (const field of ['sequence', 'lineNumber', 'price', 'amount', 'diagnosisId', 'organizationId']) {
    assert.equal(validateCreateBody({ serviceId: SVC, quantity: '1', [field]: 1 }).ok, false, field)
  }
  for (const body of [null, [], 'x']) assert.equal(validateCreateBody(body).ok, false, JSON.stringify(body))
})

test('the remove body is empty (or absent); anything else is rejected', () => {
  assert.equal(validateRemoveBody(undefined).ok, true)
  assert.equal(validateRemoveBody({}).ok, true)
  for (const body of [null, [], { reason: 'x' }, { removedAt: '2026-01-01' }]) assert.equal(validateRemoveBody(body).ok, false, JSON.stringify(body))
})

test('stored modifiers pass only as a contiguous 1..N with nonblank unique codes, returned in order', () => {
  assert.deepEqual(checkModifierInvariant([]), { ok: true, value: [] })
  assert.deepEqual(checkModifierInvariant([{ sequence: 2, code: 'M2' }, { sequence: 1, code: 'M1' }]), { ok: true, value: ['M1', 'M2'] })
  const corrupt: [string, { sequence: number; code: string }[]][] = [
    ['gap 1,3', [{ sequence: 1, code: 'M1' }, { sequence: 3, code: 'M3' }]],
    ['starts at 2', [{ sequence: 2, code: 'M2' }]],
    ['duplicate sequence', [{ sequence: 1, code: 'M1' }, { sequence: 1, code: 'M2' }]],
    ['duplicate code', [{ sequence: 1, code: 'M1' }, { sequence: 2, code: 'M1' }]],
    ['blank code', [{ sequence: 1, code: '  ' }]],
  ]
  for (const [label, rows] of corrupt) assert.equal(checkModifierInvariant(rows).ok, false, label)
})

test('the DTO carries an exact decimal string and the ordered codes, with no pricing or claim context', () => {
  const dto = toEncounterActivityDto(
    {
      id: EA,
      encounterId: ENC,
      serviceId: SVC,
      procedureCodeId: null,
      quantity: new Prisma.Decimal('2.5000'),
      unitCode: 'UNIT',
      removedAt: null,
      createdAt: new Date('2026-09-25T10:00:00.000Z'),
      updatedAt: new Date('2026-09-25T10:00:00.000Z'),
    },
    ['M1', 'M2'],
  )
  assert.equal(dto.quantity, '2.5')
  assert.equal(typeof dto.quantity, 'string')
  assert.deepEqual(dto.modifierCodes, ['M1', 'M2'])
  assert.equal(dto.removedAt, null)
  assert.equal(Object.keys(dto).some((key) => /(price|amount|tariff|claim|line|sequence|diagnos|patient|organization)/i.test(key)), false)
})

test('the audit snapshot carries only id, removedAt and updatedAt — never the activity facts', () => {
  const snapshot = encounterActivityAuditSnapshot({ id: EA, removedAt: null, updatedAt: new Date('2026-09-25T10:00:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['id', 'removedAt', 'updatedAt'])
  assert.deepEqual(Object.keys(encounterActivityAuditSnapshot({ id: EA })), ['id'])
  const text = JSON.stringify(snapshot)
  for (const value of [ENC, SVC, PROC, '2.5', 'UNIT', 'M1']) assert.equal(text.includes(value), false, value)
})
