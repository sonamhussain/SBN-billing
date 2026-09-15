import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isExecutabilityBlockerCode,
  isRuleSourceBindingUuid,
  isSourceRole,
  normalizeSourceRole,
} from './rule-source-binding.validation.ts'

test('UUID shape is accepted', () => {
  assert.equal(isRuleSourceBindingUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleSourceBindingUuid('not-a-uuid'), false)
})

test('GOVERNING and SUPPORTING are recognized source roles', () => {
  assert.equal(isSourceRole('GOVERNING'), true)
  assert.equal(isSourceRole('SUPPORTING'), true)
})

test('unknown source role rejected', () => {
  assert.equal(isSourceRole('MADE_UP'), false)
})

test('normalizeSourceRole trims and validates', () => {
  assert.equal(normalizeSourceRole('  GOVERNING  '), 'GOVERNING')
})

test('normalizeSourceRole rejects invalid value', () => {
  assert.equal(normalizeSourceRole('NOT_A_ROLE'), null)
})

test('normalizeSourceRole rejects non-string', () => {
  assert.equal(normalizeSourceRole(42), null)
})

test('all 15 A3.7/REF-01 blocker codes are recognized', () => {
  const codes = [
    'RULE_UNVERIFIED',
    'RULE_NOT_EFFECTIVE',
    'APPLICABILITY_MISMATCH',
    'MISSING_GOVERNING_SOURCE',
    'SOURCE_NOT_ACTIVE',
    'AUTHORITY_UNVERIFIED',
    'INTERPRETATION_UNVERIFIED',
    'SOURCE_NOT_EFFECTIVE',
    'SOURCE_NOT_PUBLISHED',
    'DEPENDENCY_UNRESOLVED',
    'SOURCE_CONFLICT',
    'JURISDICTION_INCOMPATIBLE',
    'OWNERSHIP_MISMATCH',
    'SOURCE_EFFECT_INCOMPATIBLE',
    'SOURCE_CONTEXT_INCOMPATIBLE',
  ]
  for (const code of codes) assert.equal(isExecutabilityBlockerCode(code), true, code)
})

test('unrelated blocker code is not an A3.7 code', () => {
  assert.equal(isExecutabilityBlockerCode('CONTRADICTORY_DATES'), false)
  assert.equal(isExecutabilityBlockerCode('EFFECTIVE_DATE_INCOMPLETE'), false)
})
