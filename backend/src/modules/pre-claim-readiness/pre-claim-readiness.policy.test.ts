import test from 'node:test'
import assert from 'node:assert/strict'
import { decideRecency, isValidatorCompatible, reduceReadiness } from './pre-claim-readiness.policy.ts'
import { READINESS_POLICY_VERSION } from './pre-claim-readiness.types.ts'

// A5.9 — the pure A5-READY-1 policy. Synthetic values only.

test('A5-READY-1 reduces outcomes by FAIL > RESTRICT > WARNING/PASS', () => {
  assert.equal(reduceReadiness(['PASS']), 'READY_FOR_REVIEW')
  assert.equal(reduceReadiness(['WARNING']), 'READY_FOR_REVIEW')
  assert.equal(reduceReadiness(['PASS', 'WARNING', 'PASS']), 'READY_FOR_REVIEW')
  assert.equal(reduceReadiness(['RESTRICT']), 'RESTRICTED')
  assert.equal(reduceReadiness(['WARNING', 'RESTRICT', 'PASS']), 'RESTRICTED')
  assert.equal(reduceReadiness(['FAIL']), 'BLOCKED')
  assert.equal(reduceReadiness(['RESTRICT', 'FAIL']), 'BLOCKED')
  assert.equal(reduceReadiness(['WARNING', 'FAIL']), 'BLOCKED')
  assert.equal(reduceReadiness(['FAIL', 'FAIL', 'PASS']), 'BLOCKED')
})

test('the reduction is order-independent', () => {
  const outcomes = ['PASS', 'WARNING', 'RESTRICT', 'FAIL']
  for (let shift = 0; shift < outcomes.length; shift += 1) {
    assert.equal(reduceReadiness([...outcomes.slice(shift), ...outcomes.slice(0, shift)]), 'BLOCKED')
  }
  assert.equal(reduceReadiness(['RESTRICT', 'PASS']), reduceReadiness(['PASS', 'RESTRICT']))
})

test('an empty or unknown outcome set fails closed', () => {
  assert.equal(reduceReadiness([]), null)
  assert.equal(reduceReadiness(['PASS', 'APPROVED']), null)
  assert.equal(reduceReadiness(['pass']), null)
  assert.equal(reduceReadiness(['FAIL', '']), null)
})

test('A5-READY-1 accepts only the named A5-VAL-1 validator contract', () => {
  assert.equal(READINESS_POLICY_VERSION, 'A5-READY-1')
  assert.equal(isValidatorCompatible('A5-READY-1', 'A5-VAL-1'), true)
  for (const version of ['A5-VAL-2', 'A5-VAL-0', 'a5-val-1', 'A5-VAL-1 ', '', 'SYNTHETIC-VAL-1']) {
    assert.equal(isValidatorCompatible('A5-READY-1', version), false, version)
  }
  assert.equal(isValidatorCompatible('A5-READY-2', 'A5-VAL-1'), false)
  assert.equal(isValidatorCompatible('constructor', 'A5-VAL-1'), false)
  assert.equal(isValidatorCompatible('__proto__', 'A5-VAL-1'), false)
})

test('recency: newer supersedes, a tie is ambiguous, otherwise latest', () => {
  assert.equal(decideRecency({ anyNewer: false, anyTied: false }), 'LATEST')
  assert.equal(decideRecency({ anyNewer: true, anyTied: false }), 'SUPERSEDED')
  assert.equal(decideRecency({ anyNewer: false, anyTied: true }), 'AMBIGUOUS')
  // A newer run decides first: the selected run is not the latest whatever else ties with it.
  assert.equal(decideRecency({ anyNewer: true, anyTied: true }), 'SUPERSEDED')
})
