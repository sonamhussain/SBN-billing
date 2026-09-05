import test from 'node:test'
import assert from 'node:assert/strict'
import { isClinicianUuid, normalizeClinicianDisplayName } from './clinician.validation.ts'

test('clinician display name is trimmed', () => {
  assert.equal(normalizeClinicianDisplayName('  Synthetic Dr Example  '), 'Synthetic Dr Example')
})

test('blank clinician display name is rejected', () => {
  assert.equal(normalizeClinicianDisplayName('   '), null)
})

test('non-string clinician display name is rejected', () => {
  assert.equal(normalizeClinicianDisplayName(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isClinicianUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isClinicianUuid('not-a-uuid'), false)
})
