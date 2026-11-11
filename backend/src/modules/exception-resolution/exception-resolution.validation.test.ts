import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateResolutionEvent } from './exception-resolution.validation.ts'

// A8.7 — the strict request validator: exact keys per event, controlled codes, a return reason only for a return, and
// server-owned fields refused. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const request = { eventCode: 'REQUEST_INTERNAL_RESOLUTION', verificationEventId: id(1), reasonCode: 'VERIFIED_INTERNAL_WORK' }
const confirm = { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: id(2), decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }
const giveBack = { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: id(2), decisionCode: 'RETURN_FOR_REWORK', returnReasonCode: 'SOURCE_INTEGRITY_CONCERN' }

test('the exact requests are accepted and normalized (T012, T013)', () => {
  assert.deepEqual(validateResolutionEvent(request), { ok: true, value: request })
  assert.deepEqual(validateResolutionEvent({ ...request, verificationEventId: id(1).toUpperCase() }), { ok: true, value: request })
  assert.deepEqual(validateResolutionEvent(confirm), { ok: true, value: { ...confirm, returnReasonCode: null } })
  assert.deepEqual(validateResolutionEvent(giveBack), { ok: true, value: giveBack })
})

test('missing, extra and server-owned fields are refused (T012–T014, T020)', () => {
  for (const key of Object.keys(request).filter((k) => k !== 'eventCode')) {
    const missing: Record<string, unknown> = { ...request }
    delete missing[key]
    assert.equal(validateResolutionEvent(missing).ok, false, key)
  }
  for (const extra of [
    'sequence', 'recordedAt', 'recordedByUserId', 'recordedByMembershipId', 'organizationId', 'claimId', 'exceptionIntakeId', 'state', 'status', 'outcome', 'current', 'latest',
    'workReportEventId', 'approvedProposalEventId', 'note', 'comment', 'amount', 'currency', 'patientName', 'diagnosis', 'attachmentUrl',
  ])
    assert.equal(validateResolutionEvent({ ...request, [extra]: 'x' }).ok, false, extra)
  // A confirmation carries no reason; a return must carry one; a request carries no decision field.
  assert.equal(validateResolutionEvent({ ...confirm, returnReasonCode: 'INSUFFICIENT_SUPPORT' }).ok, false)
  assert.equal(validateResolutionEvent({ eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: id(2), decisionCode: 'RETURN_FOR_REWORK' }).ok, false)
  assert.equal(validateResolutionEvent({ ...request, decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }).ok, false)
  assert.equal(validateResolutionEvent({ ...confirm, verificationEventId: id(1) }).ok, false)
  for (const body of [null, [], 'x', 1, undefined]) assert.equal(validateResolutionEvent(body).ok, false)
})

test('uncontrolled codes and malformed ids are refused (T016–T020)', () => {
  for (const bad of [
    { ...request, eventCode: 'CLOSE_EXCEPTION' }, { ...request, eventCode: 'resolve' }, { ...request, reasonCode: 'PAID' }, { ...request, verificationEventId: 'abc' },
    { ...request, verificationEventId: "1' OR '1'='1" }, { ...confirm, decisionCode: 'RESOLVED' }, { ...confirm, requestEventId: '' }, { ...giveBack, returnReasonCode: 'BECAUSE' },
    { ...giveBack, returnReasonCode: 7 }, { ...request, reasonCode: ['VERIFIED_INTERNAL_WORK'] },
  ]) {
    const result = validateResolutionEvent(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
    if (!result.ok) assert.equal(result.code, 'VALIDATION_ERROR')
  }
})

test('the reads take no query and no body (T098)', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ current: 'true' }, undefined), null)
  assert.notEqual(refusedReadRequest({ latest: '1' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { state: 'RESOLVED_INTERNAL' }), null)
})
