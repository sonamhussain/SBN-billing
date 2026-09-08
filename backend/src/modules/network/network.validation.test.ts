import test from 'node:test'
import assert from 'node:assert/strict'
import { isNetworkUuid, normalizeNetworkDisplayName } from './network.validation.ts'

test('network display name is trimmed', () => {
  assert.equal(normalizeNetworkDisplayName('  Synthetic Standard Network  '), 'Synthetic Standard Network')
})

test('blank network display name is rejected', () => {
  assert.equal(normalizeNetworkDisplayName('   '), null)
})

test('non-string network display name is rejected', () => {
  assert.equal(normalizeNetworkDisplayName(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isNetworkUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isNetworkUuid('not-a-uuid'), false)
})
