import test from 'node:test'
import assert from 'node:assert/strict'
import { isHistoricalOnlyReference, isHistoricalOnlyResolved } from './rule-resolution.currentness.ts'
import { utcDateOf } from '../../shared/rules/date-only.ts'

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

// REF-02 Table 5, evaluated on evaluationDate 2026-09-18.
const evaluationDate = d('2026-09-18')

const currentRule = { effectiveFrom: d('2026-01-01'), effectiveTo: null }
const expiredRule = { effectiveFrom: d('2025-01-01'), effectiveTo: d('2025-12-31') }
const currentActiveSource = { effectiveFrom: d('2026-01-01'), effectiveTo: null, activationStatus: 'ACTIVE' }

test('F02 Table 5: rule current, source ACTIVE and effective -> false', () => {
  assert.equal(isHistoricalOnlyResolved(currentRule, currentActiveSource, evaluationDate), false)
})

test('F02 Table 5: rule expired, source ACTIVE and effective -> true', () => {
  assert.equal(isHistoricalOnlyResolved(expiredRule, currentActiveSource, evaluationDate), true)
})

test('F02 Table 5: rule current, source ACTIVE but expired -> true', () => {
  const expiredSource = { effectiveFrom: d('2025-01-01'), effectiveTo: d('2026-06-30'), activationStatus: 'ACTIVE' }
  assert.equal(isHistoricalOnlyResolved(currentRule, expiredSource, evaluationDate), true)
})

test('F02 Table 5: rule current, source SUPERSEDED -> true, even while its window is open', () => {
  const superseded = { effectiveFrom: d('2026-01-01'), effectiveTo: null, activationStatus: 'SUPERSEDED' }
  assert.equal(isHistoricalOnlyResolved(currentRule, superseded, evaluationDate), true)
})

test('F02 Table 5: REFERENCE_ONLY rule expired -> true; current -> false', () => {
  assert.equal(isHistoricalOnlyReference(expiredRule, evaluationDate), true)
  assert.equal(isHistoricalOnlyReference(currentRule, evaluationDate), false)
})

test('F02 Table 5: a past businessDate does not matter when the same rule and source are still current -> false', () => {
  // The flag takes no businessDate at all: only evaluationDate decides currentness.
  assert.equal(isHistoricalOnlyResolved(currentRule, currentActiveSource, evaluationDate), false)
})

test('F02 Table 5: a period ending ON evaluationDate is still effective that inclusive day', () => {
  const endsToday = { effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-09-18') }
  const sourceEndsToday = { ...endsToday, activationStatus: 'ACTIVE' }
  assert.equal(isHistoricalOnlyResolved(endsToday, sourceEndsToday, evaluationDate), false)
  assert.equal(isHistoricalOnlyReference(endsToday, evaluationDate), false)
  // and the day after, it is not
  assert.equal(isHistoricalOnlyResolved(endsToday, sourceEndsToday, d('2026-09-19')), true)
})

test('F02 Table 5: a future-effective selection not yet current -> true', () => {
  const future = { effectiveFrom: d('2027-01-01'), effectiveTo: null }
  assert.equal(isHistoricalOnlyResolved(future, currentActiveSource, evaluationDate), true)
  assert.equal(isHistoricalOnlyReference(future, evaluationDate), true)
  const futureSource = { effectiveFrom: d('2027-01-01'), effectiveTo: null, activationStatus: 'ACTIVE' }
  assert.equal(isHistoricalOnlyResolved(currentRule, futureSource, evaluationDate), true)
})

test('F02: missing, invalid or contradictory dates never count as current', () => {
  const undated = { effectiveFrom: null, effectiveTo: null }
  const contradictory = { effectiveFrom: d('2026-12-31'), effectiveTo: d('2026-01-01') }
  const invalid = { effectiveFrom: new Date(Number.NaN), effectiveTo: null }
  for (const version of [undated, contradictory, invalid]) {
    assert.equal(isHistoricalOnlyReference(version, evaluationDate), true)
    assert.equal(isHistoricalOnlyResolved(version, currentActiveSource, evaluationDate), true)
    assert.equal(isHistoricalOnlyResolved(currentRule, { ...version, activationStatus: 'ACTIVE' }, evaluationDate), true)
  }
})

test('F02: an invalid evaluationDate fails closed to historical', () => {
  assert.equal(isHistoricalOnlyResolved(currentRule, currentActiveSource, new Date(Number.NaN)), true)
  assert.equal(isHistoricalOnlyReference(currentRule, new Date(Number.NaN)), true)
})

test('F02: utcDateOf takes the UTC calendar day, never the host time zone', () => {
  // 23:30 UTC on the 17th is already the 18th in the UAE (+04:00); the convention is UTC.
  assert.equal(utcDateOf(new Date('2026-09-17T23:30:00.000Z'))?.toISOString(), '2026-09-17T00:00:00.000Z')
  // 21:00 on the 18th at -05:00 is 02:00 UTC on the 19th.
  assert.equal(utcDateOf(new Date('2026-09-18T21:00:00-05:00'))?.toISOString(), '2026-09-19T00:00:00.000Z')
  assert.equal(utcDateOf(new Date('2026-09-18T00:00:00.000Z'))?.toISOString(), '2026-09-18T00:00:00.000Z')
  assert.equal(utcDateOf(new Date(Number.NaN)), null)
})
