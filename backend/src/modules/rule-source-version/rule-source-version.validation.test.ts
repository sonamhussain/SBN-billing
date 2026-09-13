import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuleSourceVersionUuid,
  normalizeRawEvidenceRef,
  normalizeVersion,
} from './rule-source-version.validation.ts'

test('version trims correctly', () => {
  assert.equal(normalizeVersion('  2026.1  '), '2026.1')
})

test('blank version rejected', () => {
  assert.equal(normalizeVersion('   '), null)
})

test('non-string version rejected', () => {
  assert.equal(normalizeVersion(42), null)
})

test('rawEvidenceRef trims correctly', () => {
  assert.equal(normalizeRawEvidenceRef('  synthetic-evidence://demo/2026.1  '), 'synthetic-evidence://demo/2026.1')
})

test('blank rawEvidenceRef rejected', () => {
  assert.equal(normalizeRawEvidenceRef('   '), null)
})

test('non-string rawEvidenceRef rejected', () => {
  assert.equal(normalizeRawEvidenceRef(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isRuleSourceVersionUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleSourceVersionUuid('not-a-uuid'), false)
})
