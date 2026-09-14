import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuleDefinitionUuid,
  normalizeDisplayName,
  normalizeJurisdictionCode,
  normalizeRuleKey,
} from './rule-definition.validation.ts'

test('ruleKey trims correctly', () => {
  assert.equal(normalizeRuleKey('  CLAIM_FORMAT_BASE  '), 'CLAIM_FORMAT_BASE')
})

test('blank ruleKey rejected', () => {
  assert.equal(normalizeRuleKey('   '), null)
})

test('non-string ruleKey rejected', () => {
  assert.equal(normalizeRuleKey(42), null)
})

test('displayName trims correctly', () => {
  assert.equal(normalizeDisplayName('  Synthetic Claim Format Rule  '), 'Synthetic Claim Format Rule')
})

test('blank displayName rejected', () => {
  assert.equal(normalizeDisplayName('   '), null)
})

test('jurisdictionCode trims correctly', () => {
  assert.equal(normalizeJurisdictionCode('  AE-DU  '), 'AE-DU')
})

test('blank jurisdictionCode rejected', () => {
  assert.equal(normalizeJurisdictionCode('   '), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isRuleDefinitionUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleDefinitionUuid('not-a-uuid'), false)
})
