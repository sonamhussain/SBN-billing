import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDateOnly,
  isFacilityRegulatoryProfileUuid,
  normalizeDateOnlyField,
  normalizeJurisdictionCode,
  normalizeRegulatoryAuthorityCode,
  normalizeRequiredDateOnly,
  rangesOverlap,
} from './facility-regulatory.validation.ts'

test('jurisdictionCode trims correctly', () => {
  assert.equal(normalizeJurisdictionCode('  AE-DU  '), 'AE-DU')
})

test('blank jurisdictionCode rejected', () => {
  assert.equal(normalizeJurisdictionCode('   '), null)
})

test('non-string jurisdictionCode rejected', () => {
  assert.equal(normalizeJurisdictionCode(42), null)
})

test('regulatoryAuthorityCode trims correctly', () => {
  assert.equal(normalizeRegulatoryAuthorityCode('  DHA  '), 'DHA')
})

test('blank regulatoryAuthorityCode rejected', () => {
  assert.equal(normalizeRegulatoryAuthorityCode(''), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isFacilityRegulatoryProfileUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isFacilityRegulatoryProfileUuid('not-a-uuid'), false)
})

test('normalizeRequiredDateOnly parses a valid date-only string', () => {
  const date = normalizeRequiredDateOnly('2026-01-01')
  assert.ok(date)
  assert.equal(date?.toISOString().slice(0, 10), '2026-01-01')
})

test('normalizeRequiredDateOnly rejects malformed string', () => {
  assert.equal(normalizeRequiredDateOnly('2026-01-01T00:00:00Z'), null)
})

test('normalizeRequiredDateOnly rejects non-string', () => {
  assert.equal(normalizeRequiredDateOnly(20260101), null)
})

test('normalizeDateOnlyField: absent field', () => {
  assert.deepEqual(normalizeDateOnlyField(undefined), { present: false })
})

test('normalizeDateOnlyField: explicit null clears', () => {
  assert.deepEqual(normalizeDateOnlyField(null), { present: true, valid: true, value: null })
})

test('normalizeDateOnlyField: malformed string rejected', () => {
  assert.deepEqual(normalizeDateOnlyField('not-a-date'), { present: true, valid: false })
})

test('formatDateOnly returns null for null input', () => {
  assert.equal(formatDateOnly(null), null)
})

test('formatDateOnly formats a Date back to YYYY-MM-DD', () => {
  assert.equal(formatDateOnly(new Date('2026-03-15T00:00:00.000Z')), '2026-03-15')
})

test('rangesOverlap: identical ranges overlap', () => {
  const from = new Date('2026-01-01T00:00:00.000Z')
  const to = new Date('2026-06-30T00:00:00.000Z')
  assert.equal(rangesOverlap(from, to, from, to), true)
})

test('rangesOverlap: disjoint ranges do not overlap', () => {
  const aFrom = new Date('2026-01-01T00:00:00.000Z')
  const aTo = new Date('2026-03-31T00:00:00.000Z')
  const bFrom = new Date('2026-04-01T00:00:00.000Z')
  assert.equal(rangesOverlap(aFrom, aTo, bFrom, null), false)
})

test('rangesOverlap: open-ended range overlaps anything after its start', () => {
  const aFrom = new Date('2026-01-01T00:00:00.000Z')
  const bFrom = new Date('2030-01-01T00:00:00.000Z')
  assert.equal(rangesOverlap(aFrom, null, bFrom, null), true)
})

test('rangesOverlap: touching boundary dates overlap (inclusive)', () => {
  const aFrom = new Date('2026-01-01T00:00:00.000Z')
  const aTo = new Date('2026-06-30T00:00:00.000Z')
  const bFrom = new Date('2026-06-30T00:00:00.000Z')
  assert.equal(rangesOverlap(aFrom, aTo, bFrom, null), true)
})
