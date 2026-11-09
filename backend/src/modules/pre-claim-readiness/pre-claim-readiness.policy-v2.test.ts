import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidatorCompatible, readinessPolicyFor } from './pre-claim-readiness.policy.ts'
import { isAcceptedHandoffSchema } from './pre-claim-readiness.types.ts'

// CRG-01 Checkpoint B — the explicit policy dispatcher and the accepted handoff contracts (CRG-071, CRG-072).

test('each validator has exactly one named readiness policy; anything else is refused', () => {
  assert.equal(readinessPolicyFor('A5-VAL-1'), 'A5-READY-1')
  assert.equal(readinessPolicyFor('A5-VAL-2'), 'A5-READY-2')
  for (const version of ['A5-VAL-9', 'a5-val-2', '', 'A5-VAL-2 ', 'A5-READY-2']) assert.equal(readinessPolicyFor(version), null)
  assert.equal(isValidatorCompatible('A5-READY-1', 'A5-VAL-1'), true)
  assert.equal(isValidatorCompatible('A5-READY-1', 'A5-VAL-2'), false)
  assert.equal(isValidatorCompatible('A5-READY-2', 'A5-VAL-2'), true)
  assert.equal(isValidatorCompatible('A5-READY-2', 'A5-VAL-1'), false)
})

test('A6 accepts exactly PreClaimA6HandoffV1 and PreClaimA6HandoffV2', () => {
  assert.equal(isAcceptedHandoffSchema('PreClaimA6HandoffV1'), true)
  assert.equal(isAcceptedHandoffSchema('PreClaimA6HandoffV2'), true)
  for (const version of ['PreClaimA6HandoffV3', 'preclaima6handoffv2', '', 'PreClaimA6HandoffV2 ']) assert.equal(isAcceptedHandoffSchema(version), false)
})
