import test from 'node:test'
import assert from 'node:assert/strict'
import { isFacilityUuid, normalizeFacilityName } from './facility.validation.ts'

test('facility name is trimmed', () => {
  assert.equal(normalizeFacilityName('  Synthetic Main Branch  '), 'Synthetic Main Branch')
})

test('blank facility name is rejected', () => {
  assert.equal(normalizeFacilityName('   '), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isFacilityUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})
