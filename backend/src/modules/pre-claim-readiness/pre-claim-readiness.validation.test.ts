import test from 'node:test'
import assert from 'node:assert/strict'
import { isReadinessUuid, validateAssessBody } from './pre-claim-readiness.validation.ts'

// A5.9 — request-shape checks. Synthetic values only.

test('the assessment body is empty or absent', () => {
  assert.equal(validateAssessBody(undefined), null)
  assert.equal(validateAssessBody(null), null)
  assert.equal(validateAssessBody({}), null)
})

test('every client-supplied readiness field is refused by name', () => {
  for (const field of ['readinessPolicyVersion', 'state', 'assessedAt', 'findingIds', 'counts', 'context', 'validationRunId', 'createdByUserId']) {
    const message = validateAssessBody({ [field]: 'x' })
    assert.ok(message?.includes(field), field)
  }
  assert.ok(validateAssessBody([]))
  assert.ok(validateAssessBody('READY_FOR_REVIEW'))
  assert.ok(validateAssessBody(1))
})

test('identifiers must be UUIDs', () => {
  assert.equal(isReadinessUuid('00000000-0000-4000-8000-000000000001'), true)
  for (const value of ['not-a-uuid', '', '00000000-0000-4000-8000-00000000000', "1' OR '1'='1", 42, null, undefined]) {
    assert.equal(isReadinessUuid(value), false, String(value))
  }
})
