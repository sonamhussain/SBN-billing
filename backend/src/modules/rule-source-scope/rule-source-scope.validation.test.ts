import test from 'node:test'
import assert from 'node:assert/strict'
import { categoryRequiresScope, isRuleSourceScopeUuid, scopeDimensionKeys } from './rule-source-scope.validation.ts'

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
