import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '../../../generated/prisma/client.ts'
import { evaluateLine, evaluateRun, extendedAmount, lineFingerprint, matchingRates, runFingerprint, type RateCandidate, type SourceFacts } from './claim-pricing.calculator.ts'

// A6.3 — pure pricing rules. Synthetic values only.

const D = (value: string) => new Prisma.Decimal(value)
const SVC = '00000000-0000-4000-8000-0000000000a1'
const PROC = '00000000-0000-4000-8000-0000000000b1'
const VERSION = '00000000-0000-4000-8000-0000000000c1'

const source = (overrides: Partial<SourceFacts> = {}): SourceFacts => ({
  claimLineId: '00000000-0000-4000-8000-000000000001',
  sequence: 1,
  encounterActivityId: '00000000-0000-4000-8000-000000000011',
  serviceId: null,
  procedureCodeId: PROC,
  quantity: D('1.5'),
  unitCode: null,
  modifierCodes: [],
  removed: false,
  ...overrides,
})

const rate = (id: string, overrides: Partial<RateCandidate> = {}): RateCandidate => ({
  id,
  selectorKind: 'PROCEDURE_CODE',
  serviceId: null,
  procedureCodeId: PROC,
  unitCodeKey: null,
  modifierSignature: [],
  currencyCode: 'AED',
  unitTariffAmount: D('125.25'),
  ...overrides,
})

test('the worked example: 1.5 x AED 125.2500 is AED 187.88, half-up at 2 minor units', () => {
  const line = evaluateLine(source(), [rate('r1')])
  assert.equal(line.outcome, 'PRICED')
  assert.equal(line.extendedAmount?.toFixed(2), '187.88')
  assert.equal(extendedAmount(D('1'), D('12.125'), 2).toFixed(2), '12.13')
  assert.equal(extendedAmount(D('3'), D('0.1'), 2).toFixed(2), '0.30')
  assert.equal(extendedAmount(D('0.3333'), D('3'), 2).toFixed(2), '1.00')
})

test('no matching rate is missing, an explicit zero rate is priced at 0.00', () => {
  assert.equal(evaluateLine(source(), []).outcome, 'UNPRICED_RATE_MISSING')
  const zero = evaluateLine(source({ quantity: D('2') }), [rate('r0', { unitTariffAmount: D('0') })])
  assert.equal(zero.outcome, 'PRICED')
  assert.equal(zero.extendedAmount?.toFixed(2), '0.00')
})

test('a Service rate and a Procedure rate both matching are ambiguous, even at the same price', () => {
  const both = source({ serviceId: SVC })
  const line = evaluateLine(both, [rate('rp'), rate('rs', { selectorKind: 'SERVICE', serviceId: SVC, procedureCodeId: null })])
  assert.equal(line.outcome, 'UNPRICED_RATE_AMBIGUOUS')
  assert.deepEqual(line.candidateRateIds, ['rp', 'rs'])
  assert.equal(line.extendedAmount, null)
  // Only one identity matching is not ambiguous: the other identity is simply unrated.
  assert.equal(evaluateLine(both, [rate('rp')]).outcome, 'PRICED')
})

test('unit and modifiers match exactly; null unit matches only null; modifier order does not matter', () => {
  assert.equal(matchingRates(source({ unitCode: 'SYN-U' }), [rate('r1')]).length, 0)
  assert.equal(matchingRates(source(), [rate('r1', { unitCodeKey: 'SYN-U' })]).length, 0)
  assert.equal(matchingRates(source({ unitCode: 'SYN-U' }), [rate('r1', { unitCodeKey: 'SYN-U' })]).length, 1)
  assert.equal(matchingRates(source({ modifierCodes: ['M2', 'M1'] }), [rate('r1', { modifierSignature: ['M1', 'M2'] })]).length, 1)
  assert.equal(matchingRates(source({ modifierCodes: ['M1'] }), [rate('r1', { modifierSignature: ['M1', 'M2'] })]).length, 0)
  assert.equal(matchingRates(source({ modifierCodes: ['M1'] }), [rate('r1')]).length, 0)
  assert.equal(matchingRates(source({ modifierCodes: ['m1'] }), [rate('r1', { modifierSignature: ['M1'] })]).length, 0)
})

test('an untrustworthy source is never priced', () => {
  for (const bad of [source({ removed: true }), source({ quantity: D('0') }), source({ quantity: D('-1') }), source({ serviceId: null, procedureCodeId: null }), source({ modifierCodes: [' '] })])
    assert.equal(evaluateLine(bad, [rate('r1')]).outcome, 'UNPRICED_SOURCE_INVALID')
})

test('an unconfigured currency is never priced', () => {
  assert.equal(evaluateLine(source(), [rate('r1', { currencyCode: 'USD' })]).outcome, 'UNPRICED_UNSUPPORTED_CURRENCY')
})

test('a run is PRICED only when every line priced in one currency; the total is the sum of rounded lines', () => {
  const l1 = evaluateLine(source(), [rate('r1')])
  const l2 = evaluateLine(source({ claimLineId: 'l2', sequence: 2, quantity: D('1') }), [rate('r2', { unitTariffAmount: D('12.125') })])
  const run = evaluateRun([l1, l2])
  assert.deepEqual([run.overallResult, run.lineCount, run.pricedCount, run.currencyCode, run.total?.toFixed(2)], ['PRICED', 2, 2, 'AED', '200.01'])
  const missing = evaluateRun([l1, evaluateLine(source({ claimLineId: 'l3' }), [])])
  assert.deepEqual([missing.overallResult, missing.pricedCount, missing.total, missing.currencyCode], ['INCOMPLETE', 1, null, null])
  const empty = evaluateRun([])
  assert.deepEqual([empty.overallResult, empty.lineCount, empty.total], ['INCOMPLETE', 0, null])
  const mixed = evaluateRun([l1, { ...l2, currencyCode: 'SAR' }])
  assert.deepEqual([mixed.overallResult, mixed.total], ['INCOMPLETE', null])
})

test('fingerprints are deterministic hex and change when a priced input changes', () => {
  const s = source()
  const line = evaluateLine(s, [rate('r1')])
  const first = lineFingerprint(s, line, VERSION)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(lineFingerprint(s, line, VERSION), first)
  const changedRate = evaluateLine(s, [rate('r1', { unitTariffAmount: D('125.26') })])
  assert.notEqual(lineFingerprint(s, changedRate, VERSION), first)
  assert.notEqual(lineFingerprint(source({ quantity: D('1.6') }), line, VERSION), first)
  assert.notEqual(runFingerprint('c1', VERSION, [first]), runFingerprint('c1', VERSION, [first, first]))
})
