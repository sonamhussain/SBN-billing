import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDiagnosisCodeUuid,
  normalizeDiagnosisCodeCode,
  normalizeDiagnosisCodeDisplayName,
} from './diagnosis-code.validation.ts'

test('diagnosis code trims correctly', () => {
  assert.equal(normalizeDiagnosisCodeCode('  TEST_DX_01  '), 'TEST_DX_01')
})

test('blank code rejected', () => {
  assert.equal(normalizeDiagnosisCodeCode('   '), null)
})

test('non-string code rejected', () => {
  assert.equal(normalizeDiagnosisCodeCode(42), null)
})

test('diagnosis display name trims correctly', () => {
  assert.equal(normalizeDiagnosisCodeDisplayName('  Synthetic Back Pain  '), 'Synthetic Back Pain')
})

test('blank display name rejected', () => {
  assert.equal(normalizeDiagnosisCodeDisplayName('   '), null)
})

test('non-string display name rejected', () => {
  assert.equal(normalizeDiagnosisCodeDisplayName(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isDiagnosisCodeUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isDiagnosisCodeUuid('not-a-uuid'), false)
})
