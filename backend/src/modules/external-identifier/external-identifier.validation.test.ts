import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isExternalIdentifierUuid,
  normalizeExternalValue,
  normalizeSourceSystem,
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
