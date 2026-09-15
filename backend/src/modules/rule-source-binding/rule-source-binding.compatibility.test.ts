import test from 'node:test'
import assert from 'node:assert/strict'
import { compatibilityPolicyVersion, isCompatibleGoverningEffect } from './rule-source-binding.compatibility.ts'

test('policy version is A3-COMPAT-1', () => {
  assert.equal(compatibilityPolicyVersion, 'A3-COMPAT-1')
})

test('locked example: CLINICAL_STANDARD + TARIFF_EFFECT -> INCOMPATIBLE', () => {
  assert.equal(isCompatibleGoverningEffect('CLINICAL_STANDARD', 'TARIFF_EFFECT'), false)
})

test('locked example: RESEARCH_PUBLICATION + CLAIM_EDIT_EFFECT -> INCOMPATIBLE', () => {
  assert.equal(isCompatibleGoverningEffect('RESEARCH_PUBLICATION', 'CLAIM_EDIT_EFFECT'), false)
})

test('locked example: TARIFF + PRICE_EFFECT -> COMPATIBLE', () => {
  assert.equal(isCompatibleGoverningEffect('TARIFF', 'PRICE_EFFECT'), true)
})

test('locked example: CLAIMS_STANDARD + CLAIM_FORMAT_EFFECT -> COMPATIBLE', () => {
  assert.equal(isCompatibleGoverningEffect('CLAIMS_STANDARD', 'CLAIM_FORMAT_EFFECT'), true)
})

test('REGULATORY_AUTHORITY permitted effects', () => {
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'CLAIM_FORMAT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'CLAIM_EDIT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'AUTHORIZATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'ELIGIBILITY_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'DOCUMENTATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'PRICE_EFFECT'), false)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'TARIFF_EFFECT'), false)
  assert.equal(isCompatibleGoverningEffect('REGULATORY_AUTHORITY', 'REIMBURSEMENT_EFFECT'), false)
})

test('TARIFF permitted effects', () => {
  assert.equal(isCompatibleGoverningEffect('TARIFF', 'PRICE_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TARIFF', 'TARIFF_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TARIFF', 'REIMBURSEMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TARIFF', 'CLAIM_FORMAT_EFFECT'), false)
})

test('PROVIDER_CONTRACT permitted effects', () => {
  assert.equal(isCompatibleGoverningEffect('PROVIDER_CONTRACT', 'PRICE_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PROVIDER_CONTRACT', 'REIMBURSEMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PROVIDER_CONTRACT', 'AUTHORIZATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PROVIDER_CONTRACT', 'DOCUMENTATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PROVIDER_CONTRACT', 'TARIFF_EFFECT'), false)
})

test('PAYER_POLICY permitted effects', () => {
  assert.equal(isCompatibleGoverningEffect('PAYER_POLICY', 'CLAIM_EDIT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PAYER_POLICY', 'REIMBURSEMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PAYER_POLICY', 'AUTHORIZATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PAYER_POLICY', 'ELIGIBILITY_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PAYER_POLICY', 'DOCUMENTATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('PAYER_POLICY', 'PRICE_EFFECT'), false)
})

test('TPA_POLICY permitted effects', () => {
  assert.equal(isCompatibleGoverningEffect('TPA_POLICY', 'CLAIM_EDIT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TPA_POLICY', 'AUTHORIZATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TPA_POLICY', 'ELIGIBILITY_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TPA_POLICY', 'DOCUMENTATION_REQUIREMENT_EFFECT'), true)
  assert.equal(isCompatibleGoverningEffect('TPA_POLICY', 'PRICE_EFFECT'), false)
})

test('CLINICAL_STANDARD / RESEARCH_PUBLICATION / OPERATIONAL_GUIDANCE / OTHER never govern executable effects', () => {
  const executableEffects = [
    'PRICE_EFFECT',
    'TARIFF_EFFECT',
    'CLAIM_FORMAT_EFFECT',
    'CLAIM_EDIT_EFFECT',
    'REIMBURSEMENT_EFFECT',
    'AUTHORIZATION_REQUIREMENT_EFFECT',
    'ELIGIBILITY_REQUIREMENT_EFFECT',
    'DOCUMENTATION_REQUIREMENT_EFFECT',
  ]
  for (const category of ['CLINICAL_STANDARD', 'RESEARCH_PUBLICATION', 'OPERATIONAL_GUIDANCE', 'OTHER']) {
    for (const effect of executableEffects) {
      assert.equal(isCompatibleGoverningEffect(category, effect), false, `${category} + ${effect}`)
    }
  }
})

test('unknown/future source category defaults to fail-closed INCOMPATIBLE', () => {
  assert.equal(isCompatibleGoverningEffect('SOME_FUTURE_CATEGORY', 'PRICE_EFFECT'), false)
})

test('REFERENCE_ONLY is always compatible regardless of source category', () => {
  assert.equal(isCompatibleGoverningEffect('CLINICAL_STANDARD', 'REFERENCE_ONLY'), true)
  assert.equal(isCompatibleGoverningEffect('OTHER', 'REFERENCE_ONLY'), true)
  assert.equal(isCompatibleGoverningEffect('TARIFF', 'REFERENCE_ONLY'), true)
})
