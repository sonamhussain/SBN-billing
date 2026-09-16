import test from 'node:test'
import assert from 'node:assert/strict'
import {
  forbiddenResolutionKeysPresent,
  isResolutionStatus,
  isRuleResolutionUuid,
  resolutionContextKeys,
} from './rule-resolution.validation.ts'
import { resolutionBlockerCodes, resolutionStatuses } from './rule-resolution.types.ts'
import { APPLICABILITY_DIMENSIONS_V2 } from '../../shared/rules/applicability-context-v2.ts'

const VALID = '11111111-1111-4111-8111-111111111111'

test('T08 a malformed rule definition id is rejected by shape', () => {
  assert.equal(isRuleResolutionUuid('not-a-uuid'), false)
  assert.equal(isRuleResolutionUuid(''), false)
  assert.equal(isRuleResolutionUuid(VALID), true)
})

test('resolution status union matches the A3.8 §5 contract exactly', () => {
  assert.deepEqual([...resolutionStatuses], [
    'RESOLVED',
    'REFERENCE_ONLY',
    'NO_MATCH',
    'BLOCKED_RULE_VERSION_CONFLICT',
    'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
    'BLOCKED_EXECUTABILITY',
  ])
  assert.equal(isResolutionStatus('RESOLVED'), true)
  assert.equal(isResolutionStatus('ALLOWED'), false)
})

test('A3.8 blocker codes never include an invented authority or category rank', () => {
  for (const code of resolutionBlockerCodes) {
    assert.equal(code.includes('RANK'), false)
    assert.equal(code.includes('PRIORITY'), false)
  }
})

test('REF-01 carry-forward: the context is the twelve-dimension V2 list, not the old six', () => {
  assert.equal(APPLICABILITY_DIMENSIONS_V2.length, 12)
  // Eleven are client-suppliable; facilityRegulatoryProfileId is server-derived.
  assert.equal(resolutionContextKeys.length, 11)
  assert.equal(resolutionContextKeys.includes('facilityRegulatoryProfileId'), false)
  for (const key of ['facilityId', 'insuranceProductId', 'providerContractId', 'tariffScheduleId', 'tariffScheduleVersionId'] as const) {
    assert.equal(resolutionContextKeys.includes(key), true)
  }
})

test('T12 the client can never supply jurisdiction', () => {
  assert.deepEqual(forbiddenResolutionKeysPresent({ jurisdictionCode: 'AE-DU' }), ['jurisdictionCode'])
  assert.deepEqual(forbiddenResolutionKeysPresent({ jurisdiction: 'AE-DU' }), ['jurisdiction'])
})

test('a client cannot pre-declare a winner or a precedence rank', () => {
  assert.deepEqual(forbiddenResolutionKeysPresent({ winnerId: VALID }), ['winnerId'])
  assert.deepEqual(forbiddenResolutionKeysPresent({ governingSourceId: VALID }), ['governingSourceId'])
  assert.deepEqual(forbiddenResolutionKeysPresent({ authorityRank: 1 }), ['authorityRank'])
  assert.deepEqual(forbiddenResolutionKeysPresent({ sourceCategoryRank: 1 }), ['sourceCategoryRank'])
  assert.deepEqual(forbiddenResolutionKeysPresent({ publicationDate: '2026-01-01' }), ['publicationDate'])
  assert.deepEqual(forbiddenResolutionKeysPresent({ precedencePolicyVersion: 'A3-PREC-9' }), ['precedencePolicyVersion'])
})

test('a legitimate context body carries no forbidden key', () => {
  assert.deepEqual(forbiddenResolutionKeysPresent({ businessDate: '2026-10-15', payerId: VALID, serviceId: VALID }), [])
  assert.deepEqual(forbiddenResolutionKeysPresent(null), [])
  assert.deepEqual(forbiddenResolutionKeysPresent('nonsense'), [])
})
