import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRuleSourceUuid,
  isSourceCategory,
  normalizeIssuingAuthority,
  normalizeJurisdictionCode,
  normalizeReferenceNumber,
  normalizeSourceCategory,
  normalizeTitle,
  frozenIdentityChanges,
  frozenIdentityMessage,
} from './rule-source.validation.ts'

test('jurisdictionCode trims correctly', () => {
  assert.equal(normalizeJurisdictionCode('  AE-DU  '), 'AE-DU')
})

test('blank jurisdictionCode rejected', () => {
  assert.equal(normalizeJurisdictionCode('   '), null)
})

test('non-string jurisdictionCode rejected', () => {
  assert.equal(normalizeJurisdictionCode(42), null)
})

test('issuingAuthority trims correctly', () => {
  assert.equal(normalizeIssuingAuthority('  Synthetic Authority  '), 'Synthetic Authority')
})

test('blank issuingAuthority rejected', () => {
  assert.equal(normalizeIssuingAuthority('   '), null)
})

test('non-string issuingAuthority rejected', () => {
  assert.equal(normalizeIssuingAuthority(42), null)
})

test('referenceNumber trims correctly', () => {
  assert.equal(normalizeReferenceNumber('  SYN-CS-001  '), 'SYN-CS-001')
})

test('blank referenceNumber rejected', () => {
  assert.equal(normalizeReferenceNumber('   '), null)
})

test('title trims correctly', () => {
  assert.equal(normalizeTitle('  Synthetic Claims Standard  '), 'Synthetic Claims Standard')
})

test('blank title rejected', () => {
  assert.equal(normalizeTitle('   '), null)
})

test('all approved source categories are recognized', () => {
  assert.equal(isSourceCategory('REGULATORY_AUTHORITY'), true)
  assert.equal(isSourceCategory('CLAIMS_STANDARD'), true)
  assert.equal(isSourceCategory('TARIFF'), true)
  assert.equal(isSourceCategory('PROVIDER_CONTRACT'), true)
  assert.equal(isSourceCategory('PAYER_POLICY'), true)
  assert.equal(isSourceCategory('TPA_POLICY'), true)
  assert.equal(isSourceCategory('CLINICAL_STANDARD'), true)
  assert.equal(isSourceCategory('RESEARCH_PUBLICATION'), true)
  assert.equal(isSourceCategory('OPERATIONAL_GUIDANCE'), true)
  assert.equal(isSourceCategory('OTHER'), true)
})

test('unknown sourceCategory rejected', () => {
  assert.equal(isSourceCategory('MADE_UP_CATEGORY'), false)
})

test('normalizeSourceCategory trims and validates against controlled list', () => {
  assert.equal(normalizeSourceCategory('  CLAIMS_STANDARD  '), 'CLAIMS_STANDARD')
  assert.equal(normalizeSourceCategory('NOT_A_CATEGORY'), null)
  assert.equal(normalizeSourceCategory(42), null)
})

test('UUID shape is accepted', () => {
  assert.equal(isRuleSourceUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleSourceUuid('not-a-uuid'), false)
})

// Audit F10 — source identity freeze.
const storedIdentity = {
  jurisdictionCode: 'AE-DU',
  issuingAuthority: 'DHA',
  sourceCategory: 'REGULATORY_AUTHORITY',
}

test('an empty patch changes no identity field', () => {
  assert.deepEqual(frozenIdentityChanges(storedIdentity, {}), [])
})

test('omitted and null identity fields are not changes', () => {
  assert.deepEqual(
    frozenIdentityChanges(storedIdentity, { jurisdictionCode: null, issuingAuthority: undefined }),
    [],
  )
})

test('re-sending the stored identity values is not a change', () => {
  assert.deepEqual(
    frozenIdentityChanges(storedIdentity, {
      jurisdictionCode: 'AE-DU',
      issuingAuthority: 'DHA',
      sourceCategory: 'REGULATORY_AUTHORITY',
    }),
    [],
  )
})

test('each identity field is reported when it actually differs', () => {
  assert.deepEqual(frozenIdentityChanges(storedIdentity, { jurisdictionCode: 'AE-AZ' }), ['jurisdictionCode'])
  assert.deepEqual(frozenIdentityChanges(storedIdentity, { issuingAuthority: 'HAAD' }), ['issuingAuthority'])
  assert.deepEqual(frozenIdentityChanges(storedIdentity, { sourceCategory: 'TARIFF' }), ['sourceCategory'])
})

test('all changed identity fields are reported together, in a stable order', () => {
  assert.deepEqual(
    frozenIdentityChanges(storedIdentity, {
      sourceCategory: 'TARIFF',
      jurisdictionCode: 'AE-AZ',
      issuingAuthority: 'HAAD',
    }),
    ['jurisdictionCode', 'issuingAuthority', 'sourceCategory'],
  )
})

test('identity comparison is exact, so case and spacing differences are changes', () => {
  assert.deepEqual(frozenIdentityChanges(storedIdentity, { jurisdictionCode: 'ae-du' }), ['jurisdictionCode'])
})

test('the freeze message names the offending fields and the remedy', () => {
  assert.equal(
    frozenIdentityMessage(['jurisdictionCode', 'sourceCategory']),
    'jurisdictionCode, sourceCategory cannot be changed once this rule source has versions; create a new rule source instead',
  )
})
