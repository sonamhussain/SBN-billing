import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuleApplicabilityUuid,
  normalizeOptionalUuidField,
} from './rule-applicability.validation.ts'

test('UUID shape is accepted', () => {
  assert.equal(isRuleApplicabilityUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleApplicabilityUuid('not-a-uuid'), false)
})

test('normalizeOptionalUuidField: undefined treated as null wildcard', () => {
  assert.deepEqual(normalizeOptionalUuidField(undefined), { valid: true, value: null })
})

test('normalizeOptionalUuidField: explicit null treated as wildcard', () => {
  assert.deepEqual(normalizeOptionalUuidField(null), { valid: true, value: null })
})

test('normalizeOptionalUuidField: valid uuid accepted', () => {
  assert.deepEqual(normalizeOptionalUuidField('550e8400-e29b-41d4-a716-446655440000'), {
    valid: true,
    value: '550e8400-e29b-41d4-a716-446655440000',
  })
})

test('normalizeOptionalUuidField: malformed string rejected', () => {
  assert.deepEqual(normalizeOptionalUuidField('not-a-uuid'), { valid: false })
})

test('normalizeOptionalUuidField: non-string non-null rejected', () => {
  assert.deepEqual(normalizeOptionalUuidField(42), { valid: false })
})
