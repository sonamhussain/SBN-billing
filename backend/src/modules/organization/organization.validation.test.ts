import test from 'node:test'
import assert from 'node:assert/strict'
import { isUuid, normalizeOrganizationName } from './organization.validation.ts'

test('organization name is trimmed', () => {
  assert.equal(normalizeOrganizationName('  Synthetic Demo Clinic  '), 'Synthetic Demo Clinic')
})

test('blank organization name is rejected', () => {
  assert.equal(normalizeOrganizationName('   '), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})
