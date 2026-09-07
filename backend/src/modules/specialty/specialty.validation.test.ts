import test from 'node:test'
import assert from 'node:assert/strict'
import { isSpecialtyUuid, normalizeSpecialtyDisplayName } from './specialty.validation.ts'

test('specialty display name is trimmed', () => {
  assert.equal(normalizeSpecialtyDisplayName('  Synthetic Dermatology  '), 'Synthetic Dermatology')
})

test('blank specialty display name is rejected', () => {
  assert.equal(normalizeSpecialtyDisplayName('   '), null)
})

test('non-string specialty display name is rejected', () => {
  assert.equal(normalizeSpecialtyDisplayName(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isSpecialtyUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isSpecialtyUuid('not-a-uuid'), false)
})
