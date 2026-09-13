import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuleSourceVersionUuid,
  isSourceVerificationStatus,
  normalizeBusinessDate,
  normalizeContextJurisdictionCode,
  normalizeDateOnlyField,
  normalizeRawEvidenceRef,
  normalizeVersion,
  formatDateOnly,
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

test('all approved source verification statuses are recognized', () => {
  assert.equal(isSourceVerificationStatus('UNVERIFIED'), true)
  assert.equal(isSourceVerificationStatus('IN_REVIEW'), true)
  assert.equal(isSourceVerificationStatus('VERIFIED'), true)
  assert.equal(isSourceVerificationStatus('REJECTED'), true)
})

test('unknown source verification status rejected', () => {
  assert.equal(isSourceVerificationStatus('MADE_UP'), false)
})

test('normalizeDateOnlyField: absent field', () => {
  assert.deepEqual(normalizeDateOnlyField(undefined), { present: false })
})

test('normalizeDateOnlyField: explicit null clears', () => {
  assert.deepEqual(normalizeDateOnlyField(null), { present: true, valid: true, value: null })
})

test('normalizeDateOnlyField: valid date-only string parses to UTC midnight', () => {
  const result = normalizeDateOnlyField('2026-10-01')
  assert.equal(result.present, true)
  assert.equal(result.valid, true)
  if (result.present && result.valid) {
    assert.equal(result.value?.toISOString(), '2026-10-01T00:00:00.000Z')
  }
})

test('normalizeDateOnlyField: malformed string rejected', () => {
  assert.deepEqual(normalizeDateOnlyField('not-a-date'), { present: true, valid: false })
})

test('normalizeDateOnlyField: full ISO timestamp rejected (date-only expected)', () => {
  assert.deepEqual(normalizeDateOnlyField('2026-10-01T00:00:00.000Z'), { present: true, valid: false })
})

test('normalizeDateOnlyField: non-string rejected', () => {
  assert.deepEqual(normalizeDateOnlyField(42), { present: true, valid: false })
})

test('normalizeBusinessDate parses valid date-only string', () => {
  assert.equal(normalizeBusinessDate('2026-10-15')?.toISOString(), '2026-10-15T00:00:00.000Z')
})

test('normalizeBusinessDate rejects malformed string', () => {
  assert.equal(normalizeBusinessDate('15-10-2026'), null)
})

test('normalizeBusinessDate rejects non-string', () => {
  assert.equal(normalizeBusinessDate(null), null)
})

test('formatDateOnly returns null for null input', () => {
  assert.equal(formatDateOnly(null), null)
})

test('formatDateOnly formats a Date back to YYYY-MM-DD', () => {
  assert.equal(formatDateOnly(new Date('2026-10-01T00:00:00.000Z')), '2026-10-01')
})

test('normalizeContextJurisdictionCode trims correctly', () => {
  assert.equal(normalizeContextJurisdictionCode('  AE-DU  '), 'AE-DU')
})

test('blank context jurisdictionCode rejected', () => {
  assert.equal(normalizeContextJurisdictionCode('   '), null)
})
