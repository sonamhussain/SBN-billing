import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuleEffectType,
  isRuleVersionUuid,
  normalizeEffectType,
  normalizeVersion,
  ruleEffectTypes,
} from './rule-version.validation.ts'

test('version trims correctly', () => {
  assert.equal(normalizeVersion('  1  '), '1')
})

test('blank version rejected', () => {
  assert.equal(normalizeVersion('   '), null)
})

test('non-string version rejected', () => {
  assert.equal(normalizeVersion(1), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isRuleVersionUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleVersionUuid('not-a-uuid'), false)
})

test('every approved rule effect type is recognized', () => {
  for (const effectType of ruleEffectTypes) {
    assert.equal(isRuleEffectType(effectType), true)
  }
})

test('unknown rule effect type rejected', () => {
  assert.equal(isRuleEffectType('MADE_UP_EFFECT'), false)
})

test('normalizeEffectType trims and validates', () => {
  assert.equal(normalizeEffectType('  CLAIM_FORMAT_EFFECT  '), 'CLAIM_FORMAT_EFFECT')
})

test('normalizeEffectType rejects invalid value', () => {
  assert.equal(normalizeEffectType('NOT_A_TYPE'), null)
})

test('normalizeEffectType rejects non-string', () => {
  assert.equal(normalizeEffectType(42), null)
})
