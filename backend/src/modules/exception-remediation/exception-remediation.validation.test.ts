import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateRemediationEvent } from './exception-remediation.validation.ts'

// A8.5 — the strict request shapes and the read's refusal of any input. Synthetic values only.

const F = '00000000-0000-4000-8000-0000000000f1'
const P = '00000000-0000-4000-8000-0000000000a1'
const proposal = (o: Record<string, unknown> = {}) => ({ eventCode: 'PROPOSE_ACTION', actionCode: 'RECHECK_CODING_REFERENCE', findingEventId: F, rationaleCode: 'RECORDED_CONFLICT', ...o })
const approval = (o: Record<string, unknown> = {}) => ({ eventCode: 'REVIEW_ACTION', proposalEventId: P, decisionCode: 'APPROVE_PROPOSAL', ...o })
const ret = (o: Record<string, unknown> = {}) => ({ eventCode: 'REVIEW_ACTION', proposalEventId: P, decisionCode: 'RETURN_PROPOSAL', reviewReasonCode: 'WRONG_SCOPE', ...o })

test('a proposal is exactly its own controlled fields (T012, T015–T017, T020)', () => {
  assert.deepEqual(validateRemediationEvent(proposal({ findingEventId: F.toUpperCase() })), { ok: true, value: { eventCode: 'PROPOSE_ACTION', actionCode: 'RECHECK_CODING_REFERENCE', findingEventId: F, rationaleCode: 'RECORDED_CONFLICT' } })
  for (const body of [
    proposal({ actionCode: 'EXECUTE_REMEDIATION' }), proposal({ actionCode: 'recheck_coding_reference' }), proposal({ rationaleCode: 'because' }), proposal({ findingEventId: 'x' }), proposal({ findingEventId: "1' OR '1'='1" }),
    proposal({ actorUserId: P }), proposal({ organizationId: P }), proposal({ claimId: P }), proposal({ sequence: 1 }), proposal({ recordedAt: '2026-11-05T00:00:00Z' }), proposal({ state: 'APPROVED_FOR_PLANNING' }),
    proposal({ note: 'free text' }), proposal({ proposalEventId: P }), proposal({ decisionCode: 'APPROVE_PROPOSAL' }), { eventCode: 'PROPOSE_ACTION', actionCode: 'RECHECK_CODING_REFERENCE', findingEventId: F },
    JSON.parse(`{"eventCode":"PROPOSE_ACTION","actionCode":"RECHECK_CODING_REFERENCE","findingEventId":"${F}","rationaleCode":"RECORDED_CONFLICT","__proto__":{"admin":true}}`),
  ])
    assert.equal(validateRemediationEvent(body).ok, false, JSON.stringify(body))
})

test('a review is exactly its own fields; a reason only on a return (T013, T018, T019)', () => {
  assert.deepEqual(validateRemediationEvent(approval()), { ok: true, value: { eventCode: 'REVIEW_ACTION', proposalEventId: P, decisionCode: 'APPROVE_PROPOSAL', reviewReasonCode: null } })
  assert.deepEqual(validateRemediationEvent(ret()), { ok: true, value: { eventCode: 'REVIEW_ACTION', proposalEventId: P, decisionCode: 'RETURN_PROPOSAL', reviewReasonCode: 'WRONG_SCOPE' } })
  for (const body of [
    approval({ reviewReasonCode: 'WRONG_SCOPE' }), approval({ reviewReasonCode: null }), ret({ reviewReasonCode: undefined }), ret({ reviewReasonCode: 'BECAUSE' }), approval({ decisionCode: 'AUTO_APPROVE' }),
    approval({ proposalEventId: 'x' }), approval({ actionCode: 'RECHECK_CODING_REFERENCE' }), approval({ reviewerUserId: P }), { eventCode: 'REVIEW_ACTION', decisionCode: 'APPROVE_PROPOSAL' },
  ])
    assert.equal(validateRemediationEvent(body).ok, false, JSON.stringify(body))
})

test('unknown events, arrays, nulls and primitives are refused (T014)', () => {
  for (const body of [null, undefined, [], [proposal()], 'PROPOSE_ACTION', 7, {}, { eventCode: 'EXECUTE_ACTION' }, { eventCode: 'RESOLVE' }]) assert.equal(validateRemediationEvent(body).ok, false, JSON.stringify(body))
})

test('the reads take no query and no body (T087)', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ state: 'AWAITING_REVIEW' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { latest: true }), null)
})
