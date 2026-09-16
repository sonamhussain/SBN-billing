import test from 'node:test'
import assert from 'node:assert/strict'
import { categoryMinimumScopeSatisfied, categoryRequiresScope, isRuleSourceScopeUuid, scopeDimensionKeys } from './rule-source-scope.validation.ts'

const blankRow = {
  facilityId: null,
  payerId: null,
  tpaId: null,
  networkId: null,
  insuranceProductId: null,
  providerContractId: null,
  tariffScheduleId: null,
  tariffScheduleVersionId: null,
}

test('UUID shape is accepted', () => {
  assert.equal(isRuleSourceScopeUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleSourceScopeUuid('not-a-uuid'), false)
})

test('scope dimension keys cover all eight typed commercial context fields', () => {
  assert.deepEqual(
    [...scopeDimensionKeys].sort(),
    [
      'facilityId',
      'insuranceProductId',
      'networkId',
      'payerId',
      'providerContractId',
      'tariffScheduleId',
      'tariffScheduleVersionId',
      'tpaId',
    ].sort(),
  )
})

test('PAYER_POLICY, TPA_POLICY, PROVIDER_CONTRACT and TARIFF require typed scope', () => {
  for (const category of ['PAYER_POLICY', 'TPA_POLICY', 'PROVIDER_CONTRACT', 'TARIFF']) {
    assert.equal(categoryRequiresScope(category), true)
  }
})

test('REGULATORY_AUTHORITY and CLAIMS_STANDARD do not require typed scope', () => {
  assert.equal(categoryRequiresScope('REGULATORY_AUTHORITY'), false)
  assert.equal(categoryRequiresScope('CLAIMS_STANDARD'), false)
})

test('categories that never govern (CLINICAL_STANDARD etc.) do not require scope either', () => {
  for (const category of ['CLINICAL_STANDARD', 'RESEARCH_PUBLICATION', 'OPERATIONAL_GUIDANCE', 'OTHER']) {
    assert.equal(categoryRequiresScope(category), false)
  }
})

test('PAYER_POLICY minimum: a matched row without payerId fails closed (T62)', () => {
  const matched = [{ ...blankRow, networkId: 'n1' }]
  assert.equal(categoryMinimumScopeSatisfied('PAYER_POLICY', matched), false)
})

test('PAYER_POLICY minimum: a matched row with payerId is satisfied', () => {
  const matched = [{ ...blankRow, payerId: 'p1' }]
  assert.equal(categoryMinimumScopeSatisfied('PAYER_POLICY', matched), true)
})

test('TPA_POLICY minimum requires tpaId (T63)', () => {
  assert.equal(categoryMinimumScopeSatisfied('TPA_POLICY', [{ ...blankRow, payerId: 'p1' }]), false)
  assert.equal(categoryMinimumScopeSatisfied('TPA_POLICY', [{ ...blankRow, tpaId: 't1' }]), true)
})

test('PROVIDER_CONTRACT minimum requires providerContractId (T64)', () => {
  assert.equal(categoryMinimumScopeSatisfied('PROVIDER_CONTRACT', [{ ...blankRow, payerId: 'p1' }]), false)
  assert.equal(categoryMinimumScopeSatisfied('PROVIDER_CONTRACT', [{ ...blankRow, providerContractId: 'c1' }]), true)
})

test('TARIFF minimum accepts either tariffScheduleId or tariffScheduleVersionId (T65)', () => {
  assert.equal(categoryMinimumScopeSatisfied('TARIFF', [{ ...blankRow, payerId: 'p1' }]), false)
  assert.equal(categoryMinimumScopeSatisfied('TARIFF', [{ ...blankRow, tariffScheduleId: 's1' }]), true)
  assert.equal(categoryMinimumScopeSatisfied('TARIFF', [{ ...blankRow, tariffScheduleVersionId: 'v1' }]), true)
})

test('categories with no minimum requirement are always satisfied', () => {
  assert.equal(categoryMinimumScopeSatisfied('REGULATORY_AUTHORITY', [{ ...blankRow }]), true)
})

test('no matched rows at all is never satisfied for a category with a minimum', () => {
  assert.equal(categoryMinimumScopeSatisfied('PAYER_POLICY', []), false)
})
