import test from 'node:test'
import assert from 'node:assert/strict'
import { isClaimUuid, validateCreateClaimBody } from './claim.validation.ts'

// A6.1 — request-shape checks. Synthetic values only.

test('the claim creation body is empty or absent', () => {
  assert.equal(validateCreateClaimBody(undefined), null)
  assert.equal(validateCreateClaimBody(null), null)
  assert.equal(validateCreateClaimBody({}), null)
})

test('every client-supplied claim field is refused by name', () => {
  for (const field of [
    'encounterId',
    'preClaimReadinessAssessmentId',
    'claimContractVersion',
    'handoffSchemaVersion',
    'createdByUserId',
    'createdAt',
    'readinessState',
    'validationRunId',
    'context',
    'jurisdictionCode',
  ]) {
    const message = validateCreateClaimBody({ [field]: 'x' })
    assert.ok(message?.includes(field), field)
  }
  assert.ok(validateCreateClaimBody([]))
  assert.ok(validateCreateClaimBody('A6-CLAIM-1'))
  assert.ok(validateCreateClaimBody(1))
})

test('claim identifiers must be UUIDs', () => {
  assert.equal(isClaimUuid('00000000-0000-4000-8000-000000000001'), true)
  for (const value of ['not-a-uuid', '', '00000000-0000-4000-8000-00000000000', "1' OR '1'='1", 42, null, undefined]) {
    assert.equal(isClaimUuid(value), false, String(value))
  }
})
