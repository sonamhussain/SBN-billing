import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isSourceInterpretationUuid,
  isVerificationStatus,
  normalizeInterpretationVersion,
  normalizeNormalizedInterpretationRef,
  normalizeVerificationStatus,
} from './source-interpretation.validation.ts'

test('interpretationVersion trims correctly', () => {
  assert.equal(normalizeInterpretationVersion('  1  '), '1')
})

test('blank interpretationVersion rejected', () => {
  assert.equal(normalizeInterpretationVersion('   '), null)
})

test('non-string interpretationVersion rejected', () => {
  assert.equal(normalizeInterpretationVersion(42), null)
})

test('normalizedInterpretationRef trims correctly', () => {
  assert.equal(
    normalizeNormalizedInterpretationRef('  synthetic-interpretation://demo/v1  '),
    'synthetic-interpretation://demo/v1',
  )
})

test('blank normalizedInterpretationRef rejected', () => {
  assert.equal(normalizeNormalizedInterpretationRef('   '), null)
})

test('non-string normalizedInterpretationRef rejected', () => {
  assert.equal(normalizeNormalizedInterpretationRef(42), null)
})

test('all approved verification statuses are recognized', () => {
  assert.equal(isVerificationStatus('UNVERIFIED'), true)
  assert.equal(isVerificationStatus('IN_REVIEW'), true)
  assert.equal(isVerificationStatus('VERIFIED'), true)
  assert.equal(isVerificationStatus('REJECTED'), true)
})

test('unknown verificationStatus rejected', () => {
  assert.equal(isVerificationStatus('MADE_UP_STATUS'), false)
})

test('normalizeVerificationStatus trims and validates against controlled list', () => {
  assert.equal(normalizeVerificationStatus('  IN_REVIEW  '), 'IN_REVIEW')
  assert.equal(normalizeVerificationStatus('NOT_A_STATUS'), null)
  assert.equal(normalizeVerificationStatus(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isSourceInterpretationUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isSourceInterpretationUuid('not-a-uuid'), false)
})
