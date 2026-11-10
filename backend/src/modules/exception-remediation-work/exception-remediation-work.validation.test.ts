import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateWorkEvent } from './exception-remediation-work.validation.ts'

// A8.6 — the strict request validator: exact keys per event, controlled codes, a reason only when not verified, an
// unsupported evidence kind answered as its own code, and server-owned fields refused. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const report = { eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId: id(1), workCode: 'DOCUMENTATION_CHECK_REPORTED', basisReferenceKind: 'INVESTIGATION_FINDING', basisReferenceId: id(2) }
const supported = { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: id(3), verificationCode: 'EVIDENCE_SUPPORTED' }
const notVerified = { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: id(3), verificationCode: 'EVIDENCE_NOT_VERIFIED', reasonCode: 'SOURCE_MISSING' }

test('the exact requests are accepted and normalized (T012, T013)', () => {
  assert.deepEqual(validateWorkEvent(report), { ok: true, value: report })
  assert.deepEqual(validateWorkEvent({ ...report, basisReferenceId: id(2).toUpperCase() }), { ok: true, value: report })
  assert.deepEqual(validateWorkEvent(supported), { ok: true, value: { ...supported, reasonCode: null } })
  assert.deepEqual(validateWorkEvent(notVerified), { ok: true, value: notVerified })
})

test('missing, extra and server-owned fields are refused (T012–T014, T020)', () => {
  for (const key of Object.keys(report).filter((k) => k !== 'eventCode')) {
    const missing: Record<string, unknown> = { ...report }
    delete missing[key]
    assert.equal(validateWorkEvent(missing).ok, false, key)
  }
  for (const extra of ['sequence', 'recordedAt', 'recordedByUserId', 'recordedByMembershipId', 'organizationId', 'claimId', 'state', 'status', 'outcome', 'basisReferenceContractVersion', 'note', 'amount', 'attachmentUrl'])
    assert.equal(validateWorkEvent({ ...report, [extra]: 'x' }).ok, false, extra)
  assert.equal(validateWorkEvent({ ...supported, reasonCode: 'SOURCE_MISSING' }).ok, false)
  assert.equal(validateWorkEvent({ ...supported, approvedProposalEventId: id(1) }).ok, false)
  assert.equal(validateWorkEvent({ eventCode: 'VERIFY_WORK_REPORT', workReportEventId: id(3), verificationCode: 'EVIDENCE_NOT_VERIFIED' }).ok, false)
  for (const body of [null, [], 'x', 1, undefined]) assert.equal(validateWorkEvent(body).ok, false)
})

test('uncontrolled codes and malformed ids are refused; an unknown evidence kind is UNSUPPORTED_EVIDENCE_KIND (T015–T019)', () => {
  for (const bad of [
    { ...report, eventCode: 'RESOLVE_EXCEPTION' }, { ...report, workCode: 'CLAIM_CORRECTED' }, { ...report, approvedProposalEventId: 'abc' }, { ...report, basisReferenceId: "1' OR '1'='1" },
    { ...supported, verificationCode: 'RESOLVED' }, { ...supported, workReportEventId: '' }, { ...notVerified, reasonCode: 'BECAUSE' }, { ...report, basisReferenceKind: 7 },
  ]) {
    const result = validateWorkEvent(bad)
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'VALIDATION_ERROR', JSON.stringify(bad))
  }
  for (const kind of ['ATTACHMENT', 'A7_CASE_ASSESSMENT', 'INTAKE_BASIS', 'investigation_finding']) {
    const result = validateWorkEvent({ ...report, basisReferenceKind: kind })
    assert.equal(result.ok ? '' : result.code, 'UNSUPPORTED_EVIDENCE_KIND', kind)
  }
})

test('reads take no selector or body (T014)', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ latest: '1' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { state: 'VERIFIED_INTERNAL_WORK' }), null)
})
