import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isCommercialContextUuid,
  normalizeCommercialDisplayName,
  normalizeCommercialKey,
  normalizeOptionalCommercialUuidField,
} from './commercial-context.validation.ts'

test('commercial key trims correctly', () => {
  assert.equal(normalizeCommercialKey('  PLAN-GOLD-01  '), 'PLAN-GOLD-01')
})

test('blank commercial key rejected', () => {
  assert.equal(normalizeCommercialKey('   '), null)
})

test('non-string commercial key rejected', () => {
  assert.equal(normalizeCommercialKey(42), null)
})

test('commercial display name trims correctly', () => {
  assert.equal(normalizeCommercialDisplayName('  Gold Plan  '), 'Gold Plan')
})

test('blank commercial display name rejected', () => {
  assert.equal(normalizeCommercialDisplayName(''), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isCommercialContextUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isCommercialContextUuid('not-a-uuid'), false)
})

test('normalizeOptionalCommercialUuidField: undefined treated as null wildcard', () => {
  assert.deepEqual(normalizeOptionalCommercialUuidField(undefined), { valid: true, value: null })
})

test('normalizeOptionalCommercialUuidField: explicit null treated as null wildcard', () => {
  assert.deepEqual(normalizeOptionalCommercialUuidField(null), { valid: true, value: null })
})

test('normalizeOptionalCommercialUuidField: valid uuid accepted', () => {
  assert.deepEqual(normalizeOptionalCommercialUuidField('550e8400-e29b-41d4-a716-446655440000'), {
    valid: true,
    value: '550e8400-e29b-41d4-a716-446655440000',
  })
})

test('normalizeOptionalCommercialUuidField: malformed string rejected', () => {
  assert.deepEqual(normalizeOptionalCommercialUuidField('not-a-uuid'), { valid: false })
})

test('normalizeOptionalCommercialUuidField: non-string non-null rejected', () => {
  assert.deepEqual(normalizeOptionalCommercialUuidField(42), { valid: false })
})
