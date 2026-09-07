import test from 'node:test'
import assert from 'node:assert/strict'
import { isTpaUuid, normalizeTpaDisplayName } from './tpa.validation.ts'

test('tpa display name is trimmed', () => {
  assert.equal(normalizeTpaDisplayName('  Synthetic Claims Administrator  '), 'Synthetic Claims Administrator')
})

test('blank tpa display name is rejected', () => {
  assert.equal(normalizeTpaDisplayName('   '), null)
})

test('non-string tpa display name is rejected', () => {
  assert.equal(normalizeTpaDisplayName(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isTpaUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isTpaUuid('not-a-uuid'), false)
})
