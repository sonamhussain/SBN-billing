import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isProcedureCodeUuid,
  normalizeOptionalCodeField,
  normalizeProcedureCodeDisplayName,
  normalizeProcedureCodeInternalCode,
} from './procedure-code.validation.ts'

test('procedure code internalCode is trimmed', () => {
  assert.equal(normalizeProcedureCodeInternalCode('  CONSULT_001  '), 'CONSULT_001')
})

test('blank internalCode is rejected', () => {
  assert.equal(normalizeProcedureCodeInternalCode('   '), null)
})

test('non-string internalCode is rejected', () => {
  assert.equal(normalizeProcedureCodeInternalCode(42), null)
})

test('procedure code displayName is trimmed', () => {
  assert.equal(normalizeProcedureCodeDisplayName('  General Consultation  '), 'General Consultation')
})

test('blank displayName is rejected', () => {
  assert.equal(normalizeProcedureCodeDisplayName('   '), null)
})

test('non-string displayName is rejected', () => {
  assert.equal(normalizeProcedureCodeDisplayName(42), null)
})

test('optional code field trims a provided string', () => {
  assert.deepEqual(normalizeOptionalCodeField('  CPT  '), { ok: true, value: 'CPT' })
})

test('optional code field allows undefined', () => {
  assert.deepEqual(normalizeOptionalCodeField(undefined), { ok: true, value: null })
})

test('optional code field rejects non-string', () => {
  assert.deepEqual(normalizeOptionalCodeField(42), { ok: false })
})

test('UUID shape is accepted', () => {
  assert.equal(isProcedureCodeUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('non-UUID shape is rejected', () => {
  assert.equal(isProcedureCodeUuid('not-a-uuid'), false)
})
