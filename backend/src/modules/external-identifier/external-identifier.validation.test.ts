import test from 'node:test'
import assert from 'node:assert/strict'
import {
  externalIdentifierUpdatableFields,
  isExternalIdentifierUuid,
  normalizeExternalValue,
  normalizeSourceSystem,
  validateUpdateBody,
} from './external-identifier.validation.ts'

test('sourceSystem trims correctly', () => {
  assert.equal(normalizeSourceSystem('  SYNTHETIC_PAYER_SYSTEM  '), 'SYNTHETIC_PAYER_SYSTEM')
})

test('blank sourceSystem rejected', () => {
  assert.equal(normalizeSourceSystem('   '), null)
})

test('non-string sourceSystem rejected', () => {
  assert.equal(normalizeSourceSystem(42), null)
})

test('externalValue trims correctly', () => {
  assert.equal(normalizeExternalValue('  PAYER-001  '), 'PAYER-001')
})

test('blank externalValue rejected', () => {
  assert.equal(normalizeExternalValue('   '), null)
})

test('non-string externalValue rejected', () => {
  assert.equal(normalizeExternalValue(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isExternalIdentifierUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isExternalIdentifierUuid('not-a-uuid'), false)
})

// A4.8 — a PATCH owns exactly two fields. These are written as a list rather than a count so that
// widening the set has to be a deliberate edit here.
test('exactly two fields may be changed by a PATCH', () => {
  assert.deepEqual([...externalIdentifierUpdatableFields], ['sourceSystem', 'externalValue'])
})

test('a PATCH body carrying only the two owned fields is accepted', () => {
  assert.equal(validateUpdateBody({ sourceSystem: 'S' }).ok, true)
  assert.equal(validateUpdateBody({ externalValue: 'V' }).ok, true)
  assert.equal(validateUpdateBody({ sourceSystem: 'S', externalValue: 'V' }).ok, true)
})

// The defect this closes: an unknown field used to ride along beside a legitimate one, so the
// legitimate half was applied and the rest was silently discarded. The whole body must fail.
test('an unknown or immutable field fails the whole body, even beside a legitimate field', () => {
  for (const body of [
    { sourceSystem: 'S', patientId: '550e8400-e29b-41d4-a716-446655440000' },
    { externalValue: 'V', encounterId: '550e8400-e29b-41d4-a716-446655440000' },
    { sourceSystem: 'S', payerId: '550e8400-e29b-41d4-a716-446655440000' },
    { externalValue: 'V', unexpectedField: 'x' },
    { sourceSystem: 'S', organizationId: '550e8400-e29b-41d4-a716-446655440000' },
    { sourceSystem: 'S', id: '550e8400-e29b-41d4-a716-446655440000' },
    { sourceSystem: 'S', updatedAt: '2026-01-01' },
  ]) {
    const outcome = validateUpdateBody(body)
    assert.equal(outcome.ok, false, `${JSON.stringify(body)} must be refused`)
    assert.equal(outcome.ok === false && /unknown or immutable field/.test(outcome.message), true, outcome.ok === false ? outcome.message : '')
  }
})

test('the refusal names every offending field, so the caller is not left guessing', () => {
  const outcome = validateUpdateBody({ sourceSystem: 'S', patientId: 'a', unexpectedField: 'b' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.message.includes('patientId'), true)
  assert.equal(outcome.ok === false && outcome.message.includes('unexpectedField'), true)
})

// The target refusal keeps its own long-standing message rather than being folded into the
// generic unknown-field list.
test('target, targetType and targetId still refuse as target immutability', () => {
  for (const body of [
    { target: { type: 'PATIENT', id: 'x' } },
    { sourceSystem: 'S', target: { type: 'PATIENT', id: 'x' } },
    { targetType: 'ENCOUNTER' },
    { externalValue: 'V', targetId: 'x' },
  ]) {
    const outcome = validateUpdateBody(body)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.message, 'target cannot be changed')
  }
})

test('a body that is not a plain object is refused', () => {
  assert.equal(validateUpdateBody(null).ok, false)
  assert.equal(validateUpdateBody(undefined).ok, false)
  assert.equal(validateUpdateBody([{ sourceSystem: 'S' }]).ok, false)
  assert.equal(validateUpdateBody('sourceSystem=S').ok, false)
  assert.equal(validateUpdateBody({}).ok, false, 'an empty body changes nothing')
})
