import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDateOnly,
  isEffectiveOn,
  isValidInstant,
  normalizeDateOnlyField,
  parseStrictDateOnly,
  parseStrictTimestamp,
} from './date-only.ts'
import { normalizeBusinessDate } from '../../modules/rule-source-version/rule-source-version.validation.ts'
import { isEffective } from '../../modules/rule-source-version/rule-source-version.activation.ts'
import { normalizeRequiredDateOnly, rangesOverlap } from '../../modules/facility-regulatory/facility-regulatory.validation.ts'

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

const invalidDay = new Date('not a date')

// --- C08 / F07: calendar-exact parsing ----------------------------------------------------

const impossibleDates = [
  '2026-02-29', // 2026 is not a leap year
  '2026-02-30',
  '2026-02-31', // used to become 2026-03-03
  '2026-04-31', // April has 30 days
  '2026-06-31',
  '2026-09-31',
  '2026-11-31',
  '2100-02-29', // century, not divisible by 400
  '1900-02-29',
  '2026-13-01',
  '2026-00-10',
  '2026-01-00',
  '2026-01-32',
]

test('F07: impossible calendar dates are rejected, never rolled forward', () => {
  for (const value of impossibleDates) assert.equal(parseStrictDateOnly(value), null, value)
})

test('F07: malformed shapes and timestamp strings are rejected for date-only input', () => {
  for (const value of [
    '2026-1-05',
    '2026-01-5',
    '26-01-05',
    '2026/01/05',
    ' 2026-01-05',
    '2026-01-05 ',
    '2026-01-05T00:00:00Z',
    '2026-01-05T00:00:00.000Z',
    '',
    'today',
  ]) {
    assert.equal(parseStrictDateOnly(value), null, JSON.stringify(value))
  }
  for (const value of [null, undefined, 20260105, {}, [], new Date('2026-01-05T00:00:00Z')]) {
    assert.equal(parseStrictDateOnly(value), null, String(value))
  }
})

test('F07: real leap days and month ends are accepted exactly', () => {
  for (const value of ['2024-02-29', '2000-02-29', '2026-02-28', '2026-01-31', '2026-04-30', '2026-12-31', '2026-01-01']) {
    const parsed = parseStrictDateOnly(value)
    assert.ok(parsed, value)
    assert.equal(formatDateOnly(parsed), value, value)
  }
})

test('F07: every existing parser entry point shares the strict rule', () => {
  for (const value of impossibleDates) {
    assert.equal(normalizeBusinessDate(value), null, `businessDate ${value}`)
    assert.equal(normalizeRequiredDateOnly(value), null, `facility required ${value}`)
    assert.deepEqual(normalizeDateOnlyField(value), { present: true, valid: false }, `field ${value}`)
  }
  assert.equal(formatDateOnly(normalizeBusinessDate('2024-02-29')), '2024-02-29')
  assert.equal(formatDateOnly(normalizeRequiredDateOnly('2024-02-29')), '2024-02-29')
})

test('F07: optional field keeps absent, explicit null and malformed distinct', () => {
  assert.deepEqual(normalizeDateOnlyField(undefined), { present: false })
  assert.deepEqual(normalizeDateOnlyField(null), { present: true, valid: true, value: null })
  assert.deepEqual(normalizeDateOnlyField('2026-02-31'), { present: true, valid: false })
  assert.deepEqual(normalizeDateOnlyField(''), { present: true, valid: false })
  assert.deepEqual(normalizeDateOnlyField(0), { present: true, valid: false })
  const valid = normalizeDateOnlyField('2026-03-15')
  assert.equal(valid.present && valid.valid && formatDateOnly(valid.value), '2026-03-15')
})

test('F07: formatDateOnly never formats an invalid instant', () => {
  assert.equal(formatDateOnly(null), null)
  assert.equal(formatDateOnly(invalidDay), null)
})

// --- C08: inclusive effective window --------------------------------------------------------

test('C08: the effective window is inclusive on both ends', () => {
  assert.equal(isEffectiveOn(d('2026-01-01'), d('2026-06-30'), d('2026-01-01')), true)
  assert.equal(isEffectiveOn(d('2026-01-01'), d('2026-06-30'), d('2026-06-30')), true)
})

test('C08: the day before the start and the day after the end are outside the window', () => {
  assert.equal(isEffectiveOn(d('2026-01-01'), d('2026-06-30'), d('2025-12-31')), false)
  assert.equal(isEffectiveOn(d('2026-01-01'), d('2026-06-30'), d('2026-07-01')), false)
})

test('C08: a leap-day boundary is exact', () => {
  assert.equal(isEffectiveOn(d('2024-01-01'), d('2024-02-29'), d('2024-02-29')), true)
  assert.equal(isEffectiveOn(d('2024-01-01'), d('2024-02-29'), d('2024-03-01')), false)
})

test('F07: an open-ended window has no end; a missing start is never effective', () => {
  assert.equal(isEffectiveOn(d('2026-01-01'), null, d('2099-12-31')), true)
  assert.equal(isEffectiveOn(null, null, d('2026-01-01')), false)
  assert.equal(isEffectiveOn(null, d('2026-12-31'), d('2026-01-01')), false)
})

test('F07: a contradictory period is never effective', () => {
  assert.equal(isEffectiveOn(d('2026-09-01'), d('2026-02-01'), d('2026-05-01')), false)
  assert.equal(isEffectiveOn(d('2026-09-01'), d('2026-02-01'), d('2026-09-01')), false)
})

test('F07: non-finite inputs fail closed in the pure evaluator', () => {
  assert.equal(isEffectiveOn(d('2026-01-01'), null, invalidDay), false)
  assert.equal(isEffectiveOn(invalidDay, null, d('2026-01-01')), false)
  assert.equal(isEffectiveOn(d('2026-01-01'), invalidDay, d('2026-01-02')), false)
  assert.equal(isValidInstant(invalidDay), false)
})

test('F07: A3.3 isEffective now fails closed on an Invalid Date (used to return true)', () => {
  assert.equal(isEffective(d('2026-01-01'), null, invalidDay), false)
  assert.equal(isEffective(d('2026-01-01'), null, d('2026-01-01')), true)
})

test('F07: facility rangesOverlap treats a non-finite bound as overlapping (fail closed)', () => {
  assert.equal(rangesOverlap(invalidDay, null, d('2026-01-01'), null), true)
  assert.equal(rangesOverlap(d('2026-01-01'), invalidDay, d('2027-01-01'), null), true)
  assert.equal(rangesOverlap(d('2026-01-01'), d('2026-06-30'), d('2026-07-01'), null), false)
})

// --- F07: strict timestamps for dataset maintenance -----------------------------------------

test('F07: explicit ISO-8601 instants with a zone are accepted', () => {
  assert.equal(parseStrictTimestamp('2026-09-17T10:15:00Z')?.toISOString(), '2026-09-17T10:15:00.000Z')
  assert.equal(parseStrictTimestamp('2026-09-17T10:15:30.123Z')?.toISOString(), '2026-09-17T10:15:30.123Z')
  assert.equal(parseStrictTimestamp('2026-09-17T14:15:00+04:00')?.toISOString(), '2026-09-17T10:15:00.000Z')
  assert.equal(parseStrictTimestamp('2024-02-29T00:00Z')?.toISOString(), '2024-02-29T00:00:00.000Z')
})

test('F07: lenient or overflowing timestamps are rejected', () => {
  for (const value of [
    '2026',
    '2026-09-17',
    'Sep 17 2026',
    '17 September 2026 10:00',
    '2026-09-17T10:15:00',
    '2026-02-31T00:00:00Z',
    '2026-09-17T24:00:00Z',
    '2026-09-17T10:60:00Z',
    '2026-09-17T10:15:60Z',
    '2026-09-17T10:15:00+24:00',
    '',
  ]) {
    assert.equal(parseStrictTimestamp(value), null, value)
  }
  for (const value of [null, undefined, 1789600000000, {}]) {
    assert.equal(parseStrictTimestamp(value), null, String(value))
  }
})
