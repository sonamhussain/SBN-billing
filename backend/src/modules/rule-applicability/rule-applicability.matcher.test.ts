import test from 'node:test'
import assert from 'node:assert/strict'
import { matchedApplicabilityIds, rowMatches, ruleVersionMatches } from './rule-applicability.matcher.ts'
import type { ApplicabilityRow } from './rule-applicability.matcher.ts'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const S1 = '33333333-3333-4333-8333-333333333333'

function row(overrides: Partial<ApplicabilityRow>): ApplicabilityRow {
  return {
    id: 'row-id',
    payerId: null,
    tpaId: null,
    networkId: null,
    serviceId: null,
    procedureCodeId: null,
    diagnosisCodeId: null,
    ...overrides,
  }
}

test('zero rows never match (T27)', () => {
  assert.equal(ruleVersionMatches([], {}), false)
})

test('all-null row matches any context (T28)', () => {
  assert.equal(rowMatches(row({}), {}), true)
  assert.equal(rowMatches(row({}), { payerId: P1 }), true)
})

test('exact payer match (T29)', () => {
  assert.equal(rowMatches(row({ payerId: P1 }), { payerId: P1 }), true)
})

test('payer mismatch (T30)', () => {
  assert.equal(rowMatches(row({ payerId: P1 }), { payerId: P2 }), false)
})

test('payer+service both match (T31)', () => {
  assert.equal(rowMatches(row({ payerId: P1, serviceId: S1 }), { payerId: P1, serviceId: S1 }), true)
})

test('payer match but service mismatch (T32)', () => {
  assert.equal(rowMatches(row({ payerId: P1, serviceId: S1 }), { payerId: P1, serviceId: P2 }), false)
})

test('missing context for required dimension (T33)', () => {
  assert.equal(rowMatches(row({ payerId: P1 }), {}), false)
})

test('multiple rows OR semantics: one matching row is enough (T34)', () => {
  const rows = [row({ id: 'a', payerId: P2 }), row({ id: 'b', payerId: P1 })]
  assert.equal(ruleVersionMatches(rows, { payerId: P1 }), true)
})

test('multiple fields AND semantics: every non-null field required (T35)', () => {
  const r = row({ payerId: P1, serviceId: S1 })
  assert.equal(rowMatches(r, { payerId: P1 }), false)
  assert.equal(rowMatches(r, { payerId: P1, serviceId: S1 }), true)
})

test('matchedApplicabilityIds returns only matching row ids', () => {
  const rows = [row({ id: 'a', payerId: P1 }), row({ id: 'b', payerId: P2 })]
  assert.deepEqual(matchedApplicabilityIds(rows, { payerId: P1 }), ['a'])
})

test('null in explicit undefined context field never matches non-null row requirement', () => {
  assert.equal(rowMatches(row({ payerId: P1 }), { payerId: undefined }), false)
  assert.equal(rowMatches(row({ payerId: P1 }), { payerId: null }), false)
})
