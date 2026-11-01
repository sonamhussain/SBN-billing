import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateTriageEvent } from './exception-triage.validation.ts'

// A8.2 — the strict request contract. Synthetic values only.

const M1 = '00000000-0000-4000-8000-0000000000e1'

test('each event accepts exactly its own controlled attributes', () => {
  assert.deepEqual(validateTriageEvent({ eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW', priorityCode: 'ROUTINE' }), { ok: true, value: { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW', priorityCode: 'ROUTINE' } })
  assert.deepEqual(validateTriageEvent({ eventCode: 'ASSIGN_OWNER', assignedMemberId: M1.toUpperCase() }), { ok: true, value: { eventCode: 'ASSIGN_OWNER', assignedMemberId: M1 } })
  assert.deepEqual(validateTriageEvent({ eventCode: 'REASSIGN_OWNER', assignedMemberId: M1 }), { ok: true, value: { eventCode: 'REASSIGN_OWNER', assignedMemberId: M1 } })
  assert.deepEqual(validateTriageEvent({ eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNMENT_INCORRECT' }), { ok: true, value: { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNMENT_INCORRECT' } })
})

test('extra, missing and server-owned fields are refused', () => {
  for (const body of [
    { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW', priorityCode: 'ROUTINE', assignedMemberId: M1 },
    { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW' },
    { eventCode: 'ASSIGN_OWNER', assignedMemberId: M1, sequence: 2 },
    { eventCode: 'ASSIGN_OWNER', assignedMemberId: M1, recordedByUserId: M1 },
    { eventCode: 'ASSIGN_OWNER', assignedMemberId: M1, organizationId: M1 },
    { eventCode: 'ASSIGN_OWNER', assignedMemberId: M1, recordedAt: '2020-01-01T00:00:00.000Z' },
    { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNEE_UNAVAILABLE', note: 'free text' },
    { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNEE_UNAVAILABLE', dispositionCode: 'TRIAGED' },
  ]) {
    assert.equal(validateTriageEvent(body).ok, false, JSON.stringify(body))
  }
})

test('unknown codes and malformed values are refused', () => {
  for (const body of [
    null, [], 'TRIAGE_CLASSIFY', {}, { eventCode: 'RESOLVE' }, { eventCode: 'triage_classify', categoryCode: 'HUMAN_REVIEW', priorityCode: 'ROUTINE' },
    { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'PAYER_DENIAL', priorityCode: 'ROUTINE' },
    { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW', priorityCode: 'CRITICAL' },
    { eventCode: 'ASSIGN_OWNER', assignedMemberId: 'not-a-uuid' },
    { eventCode: 'ASSIGN_OWNER', assignedMemberId: 42 },
    { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'RESOLVED' },
  ]) {
    assert.equal(validateTriageEvent(body).ok, false, JSON.stringify(body))
  }
})

test('the reads take no query and no body', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ current: 'true' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { latest: true }), null)
})
