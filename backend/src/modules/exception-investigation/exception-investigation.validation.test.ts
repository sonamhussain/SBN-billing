import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateInvestigationEvent } from './exception-investigation.validation.ts'

// A8.3 — the strict request contract. Synthetic values only.

const R1 = '00000000-0000-4000-8000-0000000000f1'
const L1 = '00000000-0000-4000-8000-000000000101'
const link = (evidenceKind: string, evidenceContractVersion: string) => ({ eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind, evidenceRecordId: R1, evidenceContractVersion })

test('each event accepts exactly its own controlled attributes, each kind under its one contract', () => {
  assert.deepEqual(validateInvestigationEvent({ ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), evidenceRecordId: R1.toUpperCase() }), {
    ok: true,
    value: { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: R1, evidenceContractVersion: 'A8-EXCEPTION-INTAKE-1' },
  })
  assert.equal(validateInvestigationEvent(link('TRIAGE_EVENT', 'A8-EXCEPTION-TRIAGE-1')).ok, true)
  assert.equal(validateInvestigationEvent(link('A7_CASE_ASSESSMENT', 'A7-CLOSURE-PREREQ-1')).ok, true)
  assert.deepEqual(validateInvestigationEvent({ eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'EVIDENCE_INCONCLUSIVE' }), {
    ok: true,
    value: { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'EVIDENCE_INCONCLUSIVE' },
  })
})

test('extra, missing and server-owned fields are refused', () => {
  for (const body of [
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), evidenceBasisCode: 'UNLINKED_FROZEN_SUBMISSION' },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), sequence: 1 },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), recordedByUserId: R1 },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), recordedByMembershipId: R1 },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), organizationId: R1 },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), recordedAt: '2020-01-01T00:00:00.000Z' },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), sourceFingerprintSha256: 'a'.repeat(64) },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), url: 'https://example.invalid/record' },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), findingCode: 'EVIDENCE_INCONCLUSIVE' },
    { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: R1 },
    { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'EVIDENCE_INCONCLUSIVE', note: 'free text' },
    { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'EVIDENCE_INCONCLUSIVE', patientName: 'synthetic' },
    { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'EVIDENCE_INCONCLUSIVE', amount: 10 },
    { eventCode: 'RECORD_FINDING', findingCode: 'EVIDENCE_INCONCLUSIVE' },
  ]) {
    assert.equal(validateInvestigationEvent(body).ok, false, JSON.stringify(body))
  }
})

test('unknown codes, kinds, contracts and malformed values are refused', () => {
  for (const body of [
    null, [], 'RECORD_FINDING', {}, { eventCode: 'RESOLVE_EXCEPTION' }, { eventCode: 'ASSIGN_OWNER', assignedMemberId: R1 },
    link('EXTERNAL_URL', 'A8-EXCEPTION-INTAKE-1'), link('intake_basis', 'A8-EXCEPTION-INTAKE-1'),
    link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-2'), link('INTAKE_BASIS', 'A8-EXCEPTION-TRIAGE-1'), link('TRIAGE_EVENT', 'A8-EXCEPTION-TRIAGE-2'), link('A7_CASE_ASSESSMENT', 'A7-CLOSURE-PREREQ-0'),
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), evidenceRecordId: 'not-a-uuid' },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), evidenceRecordId: "1' OR '1'='1" },
    { ...link('INTAKE_BASIS', 'A8-EXCEPTION-INTAKE-1'), evidenceRecordId: '../../etc/passwd' },
    { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'PAYMENT_DENIED' },
    { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: L1, findingCode: 'RESOLVED' },
    { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: 42, findingCode: 'EVIDENCE_INCONCLUSIVE' },
    JSON.parse('{"eventCode":"RECORD_FINDING","linkedEvidenceEventId":"00000000-0000-4000-8000-000000000101","findingCode":"EVIDENCE_INCONCLUSIVE","__proto__":{"admin":true}}'),
  ]) {
    assert.equal(validateInvestigationEvent(body).ok, false, JSON.stringify(body))
  }
})

test('the reads take no query and no body', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ current: 'true' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { latest: true }), null)
})
