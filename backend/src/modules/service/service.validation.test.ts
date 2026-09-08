import test from 'node:test'
import assert from 'node:assert/strict'
import { isServiceUuid, normalizeServiceDisplayName, normalizeServiceInternalCode } from './service.validation.ts'

test('service display name is trimmed', () => {
  assert.equal(normalizeServiceDisplayName('  General Consultation  '), 'General Consultation')
})

test('blank service display name is rejected', () => {
  assert.equal(normalizeServiceDisplayName('   '), null)
})

test('non-string service display name is rejected', () => {
  assert.equal(normalizeServiceDisplayName(42), null)
})

test('service internal code is trimmed', () => {
  assert.equal(normalizeServiceInternalCode('  CONSULT_GENERAL  '), 'CONSULT_GENERAL')
})

test('blank service internal code is rejected', () => {
  assert.equal(normalizeServiceInternalCode('   '), null)
})

test('non-string service internal code is rejected', () => {
  assert.equal(normalizeServiceInternalCode(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isServiceUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isServiceUuid('not-a-uuid'), false)
})
