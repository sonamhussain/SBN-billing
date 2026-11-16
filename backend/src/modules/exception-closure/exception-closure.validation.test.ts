import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateClosureEvent } from './exception-closure.validation.ts'

// A8.9 — the strict request validator: exact keys, controlled codes, and server-owned fields (the basis owner contract
// included) refused. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const close = { eventCode: 'CONFIRM_INTERNAL_CLOSURE', resolutionDecisionEventId: id(1), closureReasonCode: 'VERIFIED_INTERNAL_RESOLUTION', basisReferenceKind: 'RESOLUTION_DECISION', basisReferenceId: id(1) }

test('the exact request is accepted and normalized (T012–T014)', () => {
  assert.deepEqual(validateClosureEvent(close), { ok: true, value: close })
  assert.deepEqual(validateClosureEvent({ ...close, resolutionDecisionEventId: id(1).toUpperCase(), basisReferenceId: id(1).toUpperCase() }), { ok: true, value: close })
  const onReturn = { ...close, closureReasonCode: 'TERMINAL_FOLLOWUP_REVIEWED', basisReferenceKind: 'ESCALATION_RETURN', basisReferenceId: id(2) }
  assert.deepEqual(validateClosureEvent(onReturn), { ok: true, value: onReturn })
})

test('missing, extra and server-owned fields are refused (T012, T015, T016, T019, T020)', () => {
  for (const key of Object.keys(close).filter((k) => k !== 'eventCode')) {
    const missing: Record<string, unknown> = { ...close }
    delete missing[key]
    assert.equal(validateClosureEvent(missing).ok, false, key)
  }
  for (const extra of [
    'sequence', 'recordedAt', 'recordedByUserId', 'recordedByMembershipId', 'organizationId', 'claimId', 'exceptionIntakeId', 'contractVersion', 'basisOwnerContractVersion', 'state', 'status',
    'outcome', 'current', 'latest', 'closed', 'reopen', 'note', 'comment', 'reasonText', 'amount', 'currency', 'patientName', 'diagnosis', 'attachmentUrl', 'payerStatus',
  ])
    assert.equal(validateClosureEvent({ ...close, [extra]: 'x' }).ok, false, extra)
  for (const body of [null, [], 'x', 1, undefined]) assert.equal(validateClosureEvent(body).ok, false)
})

test('uncontrolled codes and malformed ids are refused (T013, T014, T017, T018)', () => {
  for (const bad of [
    { ...close, eventCode: 'CLOSE_EXCEPTION' }, { ...close, eventCode: 'REOPEN_INTERNAL_CLOSURE' }, { ...close, closureReasonCode: 'PAID' }, { ...close, closureReasonCode: 'resolved' },
    { ...close, basisReferenceKind: 'WORK_VERIFICATION' }, { ...close, basisReferenceKind: 'TRIAGE_EVENT' }, { ...close, resolutionDecisionEventId: 'abc' }, { ...close, basisReferenceId: "1' OR '1'='1" },
    { ...close, basisReferenceId: 7 }, { ...close, closureReasonCode: ['VERIFIED_INTERNAL_RESOLUTION'] },
  ]) {
    const result = validateClosureEvent(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
    if (!result.ok) assert.equal(result.code, 'VALIDATION_ERROR')
  }
})

test('the reads take no query and no body (T098)', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ current: 'true' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { state: 'CLOSED_INTERNAL' }), null)
})
