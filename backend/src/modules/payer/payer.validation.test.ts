import test from 'node:test'
import assert from 'node:assert/strict'
import { isPayerUuid, normalizePayerDisplayName } from './payer.validation.ts'

test('payer display name is trimmed', () => {
  assert.equal(normalizePayerDisplayName('  Synthetic Insurance Payer  '), 'Synthetic Insurance Payer')
})

test('blank payer display name is rejected', () => {
  assert.equal(normalizePayerDisplayName('   '), null)
})

test('non-string payer display name is rejected', () => {
  assert.equal(normalizePayerDisplayName(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isPayerUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isPayerUuid('not-a-uuid'), false)
})
