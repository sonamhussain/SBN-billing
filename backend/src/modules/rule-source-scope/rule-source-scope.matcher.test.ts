import test from 'node:test'
import assert from 'node:assert/strict'
import { matchedScopeIds, scopeRowMatches, sourceScopeMatches, type ScopeRow } from './rule-source-scope.matcher.ts'

const blankRow: Omit<ScopeRow, 'id'> = {
  facilityId: null,
  payerId: null,
  tpaId: null,
  networkId: null,
  insuranceProductId: null,
  providerContractId: null,
  tariffScheduleId: null,
  tariffScheduleVersionId: null,
}

test('zero rows never match', () => {
  assert.equal(sourceScopeMatches([], { payerId: 'p1' }), false)
})

test('all-null row matches any context', () => {
  const rows: ScopeRow[] = [{ id: 'r1', ...blankRow }]
  assert.equal(sourceScopeMatches(rows, { payerId: 'p1', providerContractId: 'c1' }), true)
})

test('exact payer match', () => {
  const rows: ScopeRow[] = [{ id: 'r1', ...blankRow, payerId: 'p1' }]
  assert.equal(sourceScopeMatches(rows, { payerId: 'p1' }), true)
})

test('payer mismatch', () => {
  const rows: ScopeRow[] = [{ id: 'r1', ...blankRow, payerId: 'p1' }]
  assert.equal(sourceScopeMatches(rows, { payerId: 'p2' }), false)
})

test('payer+contract both must match (AND within row)', () => {
  const rows: ScopeRow[] = [{ id: 'r1', ...blankRow, payerId: 'p1', providerContractId: 'c1' }]
  assert.equal(sourceScopeMatches(rows, { payerId: 'p1', providerContractId: 'c1' }), true)
  assert.equal(sourceScopeMatches(rows, { payerId: 'p1', providerContractId: 'c2' }), false)
})

test('missing context for a required dimension does not match', () => {
  const rows: ScopeRow[] = [{ id: 'r1', ...blankRow, payerId: 'p1' }]
  assert.equal(sourceScopeMatches(rows, {}), false)
})

test('multiple rows OR: one matching row is enough', () => {
  const rows: ScopeRow[] = [
    { id: 'r1', ...blankRow, payerId: 'p1' },
    { id: 'r2', ...blankRow, payerId: 'p2' },
  ]
  assert.equal(sourceScopeMatches(rows, { payerId: 'p2' }), true)
})

test('matchedScopeIds returns only matching row ids', () => {
  const rows: ScopeRow[] = [
    { id: 'r1', ...blankRow, payerId: 'p1' },
    { id: 'r2', ...blankRow, payerId: 'p2' },
  ]
  assert.deepEqual(matchedScopeIds(rows, { payerId: 'p2' }), ['r2'])
})

test('scopeRowMatches: tariffScheduleVersion dimension is exact', () => {
  const row: ScopeRow = { id: 'r1', ...blankRow, tariffScheduleVersionId: 'v1' }
  assert.equal(scopeRowMatches(row, { tariffScheduleVersionId: 'v1' }), true)
  assert.equal(scopeRowMatches(row, { tariffScheduleVersionId: 'v2' }), false)
})
