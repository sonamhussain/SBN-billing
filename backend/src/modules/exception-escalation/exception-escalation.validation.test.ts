import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateEscalationEvent } from './exception-escalation.validation.ts'

// A8.8 — the strict request validator: exact keys per event, controlled codes, and server-owned fields (the source kind
// included) refused. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const escalate = { eventCode: 'ESCALATE_FOR_REVIEW', reasonCode: 'EVIDENCE_INCOMPLETE', targetMemberId: id(1) }
const ack = { eventCode: 'ACKNOWLEDGE_ESCALATION', escalationEventId: id(2) }
const followup = { eventCode: 'RECORD_FOLLOWUP', acknowledgementEventId: id(3), followupCode: 'ADDITIONAL_INFORMATION_REQUESTED', sourceEventId: id(4) }
const giveBack = { eventCode: 'RETURN_TO_OWNER', escalationEventId: id(2), returnReasonCode: 'FURTHER_WORK_REQUIRED' }
const all = [escalate, ack, followup, giveBack]

test('the exact requests are accepted and normalized (T012–T015)', () => {
  for (const body of all) assert.deepEqual(validateEscalationEvent(body), { ok: true, value: body })
  assert.deepEqual(validateEscalationEvent({ ...escalate, targetMemberId: id(1).toUpperCase() }), { ok: true, value: escalate })
  assert.deepEqual(validateEscalationEvent({ ...followup, sourceEventId: id(4).toUpperCase() }), { ok: true, value: followup })
})

test('missing, extra and server-owned fields are refused (T012–T016, T019, T020)', () => {
  for (const body of all) {
    for (const key of Object.keys(body).filter((k) => k !== 'eventCode')) {
      const missing: Record<string, unknown> = { ...body }
      delete missing[key]
      assert.equal(validateEscalationEvent(missing).ok, false, `${body.eventCode} without ${key}`)
    }
    for (const extra of [
      'sequence', 'recordedAt', 'recordedByUserId', 'recordedByMembershipId', 'organizationId', 'claimId', 'exceptionIntakeId', 'state', 'status', 'outcome', 'current', 'latest',
      'sourceEventKind', 'targetUserId', 'priority', 'dueAt', 'slaHours', 'note', 'comment', 'reasonText', 'amount', 'currency', 'patientName', 'diagnosis', 'attachmentUrl',
    ])
      assert.equal(validateEscalationEvent({ ...body, [extra]: 'x' }).ok, false, `${body.eventCode} + ${extra}`)
  }
  // Each event carries only its own attributes.
  assert.equal(validateEscalationEvent({ ...ack, targetMemberId: id(1) }).ok, false)
  assert.equal(validateEscalationEvent({ ...giveBack, acknowledgementEventId: id(3) }).ok, false)
  assert.equal(validateEscalationEvent({ ...followup, escalationEventId: id(2) }).ok, false)
  assert.equal(validateEscalationEvent({ ...escalate, returnReasonCode: 'FOLLOWUP_RECORDED' }).ok, false)
  for (const body of [null, [], 'x', 1, undefined]) assert.equal(validateEscalationEvent(body).ok, false)
})

test('uncontrolled codes and malformed ids are refused (T017, T018)', () => {
  for (const bad of [
    { ...escalate, eventCode: 'ESCALATE' }, { ...escalate, eventCode: 'CLOSE_EXCEPTION' }, { ...escalate, reasonCode: 'URGENT' }, { ...escalate, reasonCode: 'MEDICAL_EMERGENCY' },
    { ...escalate, targetMemberId: 'abc' }, { ...escalate, targetMemberId: "1' OR '1'='1" }, { ...ack, escalationEventId: '' }, { ...followup, followupCode: 'DONE' },
    { ...followup, sourceEventId: 'x' }, { ...followup, acknowledgementEventId: 7 }, { ...giveBack, returnReasonCode: 'CLOSED' }, { ...giveBack, returnReasonCode: ['FOLLOWUP_RECORDED'] },
  ]) {
    const result = validateEscalationEvent(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
    if (!result.ok) assert.equal(result.code, 'VALIDATION_ERROR')
  }
})

test('the reads take no query and no body (T098)', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ current: 'true' }, undefined), null)
  assert.notEqual(refusedReadRequest({ state: 'FOLLOWUP_ACTIVE' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { state: 'RETURNED_TO_OWNER' }), null)
})
