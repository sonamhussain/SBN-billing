import test from 'node:test'
import assert from 'node:assert/strict'
import { NOT_STARTED, applyInvestigationEvent, deriveInvestigation, reconcileAttempt } from './exception-investigation.reducer.ts'
import { INVESTIGATION_CONTRACT_VERSION, type InvestigationEventFacts, type InvestigationEventShape, type InvestigationState } from './exception-investigation.types.ts'

// A8.3 — the evidence-before-finding rules, exhaustively, and the read-side refusals. Synthetic values only.

const R1 = '00000000-0000-4000-8000-0000000000f1'
const R2 = '00000000-0000-4000-8000-0000000000f2'
const parent = { exceptionIntakeId: '00000000-0000-4000-8000-0000000000a1', organizationId: '00000000-0000-4000-8000-0000000000b1', claimId: '00000000-0000-4000-8000-0000000000c1' }
const idOf = (sequence: number) => `00000000-0000-4000-8000-0000000001${String(sequence).padStart(2, '0')}`

const none = { evidenceKind: null, evidenceRecordId: null, evidenceContractVersion: null, evidenceBasisCode: null, linkedEvidenceEventId: null, findingCode: null }
const basis = (record = R1, basisCode: string | null = 'UNLINKED_FROZEN_SUBMISSION'): InvestigationEventShape => ({ ...none, eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: record, evidenceContractVersion: 'A8-EXCEPTION-INTAKE-1', evidenceBasisCode: basisCode })
const triage = (record = R2): InvestigationEventShape => ({ ...none, eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'TRIAGE_EVENT', evidenceRecordId: record, evidenceContractVersion: 'A8-EXCEPTION-TRIAGE-1' })
const assessment = (record = R2): InvestigationEventShape => ({ ...none, eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'A7_CASE_ASSESSMENT', evidenceRecordId: record, evidenceContractVersion: 'A7-CLOSURE-PREREQ-1' })
const finding = (link = idOf(1), findingCode = 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT'): InvestigationEventShape => ({ ...none, eventCode: 'RECORD_FINDING', linkedEvidenceEventId: link, findingCode })

const after = (state: InvestigationState, event: InvestigationEventShape) => {
  const next = applyInvestigationEvent(state, event, idOf(state.lastSequence + 1))
  assert.ok(next.ok, JSON.stringify(next))
  return next.state
}
const facts = (events: InvestigationEventShape[]): InvestigationEventFacts[] => events.map((event, index) => ({ ...parent, id: idOf(index + 1), contractVersion: INVESTIGATION_CONTRACT_VERSION, sequence: index + 1, ...event }))

test('the worked scenario: a basis link, then a finding on it', () => {
  const linked = after(NOT_STARTED, basis())
  assert.equal(linked.investigationCode, 'EVIDENCE_LINKED')
  assert.deepEqual(linked.links, [{ investigationEventId: idOf(1), sequence: 1, evidenceKind: 'INTAKE_BASIS', evidenceRecordId: R1, evidenceContractVersion: 'A8-EXCEPTION-INTAKE-1', evidenceBasisCode: 'UNLINKED_FROZEN_SUBMISSION' }])
  const found = after(linked, finding())
  assert.equal(found.investigationCode, 'FINDING_RECORDED')
  assert.deepEqual(found.findings, [{ investigationEventId: idOf(2), sequence: 2, findingCode: 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT', linkedEvidenceEventId: idOf(1) }])
  assert.equal(found.lastSequence, 2)
})

test('a finding needs an earlier link of this intake, and never repeats the latest finding unchanged', () => {
  assert.equal(applyInvestigationEvent(NOT_STARTED, finding()).ok, false)
  const linked = after(after(NOT_STARTED, basis()), triage())
  assert.equal(applyInvestigationEvent(linked, finding(R1)).ok, false, 'a record id is not a link event id')
  assert.equal(applyInvestigationEvent(linked, finding(idOf(9))).ok, false, 'an unknown link')
  const first = after(linked, finding(idOf(1), 'EVIDENCE_INCONCLUSIVE'))
  assert.equal(applyInvestigationEvent(first, finding(idOf(1), 'EVIDENCE_INCONCLUSIVE')).ok, false)
  // Another code, or the same code on another link, appends; the first finding stays exactly as it was.
  const second = after(first, finding(idOf(1), 'FURTHER_REVIEW_REQUIRED'))
  const third = after(second, finding(idOf(2), 'FURTHER_REVIEW_REQUIRED'))
  assert.deepEqual(third.findings[0], first.findings[0])
  assert.deepEqual(third.findings.map((f) => f.sequence), [3, 4, 5])
})

test('the same record is linked once per kind', () => {
  const linked = after(NOT_STARTED, assessment(R1))
  assert.equal(applyInvestigationEvent(linked, assessment(R1)).ok, false)
  assert.equal(after(linked, basis(R1, 'ASSESSMENT_REVIEW_REQUIRED')).links.length, 2, 'the same record under another kind is another link')
})

test('an event of the wrong shape or an unknown code is refused from every state', () => {
  const states = [NOT_STARTED, after(NOT_STARTED, basis()), after(after(NOT_STARTED, basis()), finding())]
  for (const state of states) {
    for (const event of [
      basis(R1, null), basis(R1, 'PAID'), { ...triage(), evidenceBasisCode: 'UNLINKED_FROZEN_SUBMISSION' }, { ...triage(), evidenceContractVersion: 'A8-EXCEPTION-TRIAGE-2' },
      { ...assessment(), evidenceContractVersion: 'A8-EXCEPTION-TRIAGE-1' }, { ...basis(), evidenceKind: 'EXTERNAL_URL' }, { ...basis(), evidenceRecordId: 'not-a-uuid' },
      { ...basis(), findingCode: 'EVIDENCE_INCONCLUSIVE' }, { ...basis(), linkedEvidenceEventId: idOf(1) },
      { ...finding(), findingCode: 'PAYMENT_DENIED' }, { ...finding(), findingCode: 'RESOLVED' }, { ...finding(), linkedEvidenceEventId: null }, { ...finding(), evidenceKind: 'INTAKE_BASIS' },
      { ...none, eventCode: 'RESOLVE_EXCEPTION' }, { ...none, eventCode: 'ASSIGN_OWNER' },
    ]) {
      assert.equal(applyInvestigationEvent(state, event).ok, false, `${state.investigationCode} + ${JSON.stringify(event)}`)
    }
  }
})

test('a stored history derives exactly, and is refused whole when it is not exactly 1..N of this intake', () => {
  const history = facts([basis(), triage(), finding(), finding(idOf(2), 'FURTHER_REVIEW_REQUIRED')])
  const derived = deriveInvestigation(parent, history)
  assert.ok(derived.ok)
  assert.equal(derived.value.investigationCode, 'FINDING_RECORDED')
  assert.equal(derived.value.links.length, 2)
  assert.equal(derived.value.findings.length, 2)
  assert.deepEqual(deriveInvestigation(parent, []), { ok: true, value: NOT_STARTED })
  for (const broken of [
    history.filter((event) => event.sequence !== 2),
    [history[0], { ...history[1], sequence: 1 }],
    [history[1], history[0]],
    [{ ...history[0], contractVersion: 'A8-EXCEPTION-INVESTIGATION-2' }],
    [{ ...history[0], organizationId: R2 }],
    [{ ...history[0], exceptionIntakeId: R2 }],
    [{ ...history[0], claimId: R2 }],
    [{ ...history[0], id: 'not-a-uuid' }],
    facts([finding(), basis()]),
    facts([basis(), finding(idOf(3))]),
    facts([basis(), { ...finding(), findingCode: 'CLOSED' }]),
  ]) {
    assert.equal(deriveInvestigation(parent, broken).ok, false, JSON.stringify(broken.map((e) => [e.sequence, e.eventCode])))
  }
})

test('derivation is deterministic', () => {
  const history = facts([basis(), assessment(), finding(idOf(2), 'EVIDENCE_INCONCLUSIVE')])
  const first = JSON.stringify(deriveInvestigation(parent, history))
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(deriveInvestigation(parent, history)), first)
})

test('an uncertain attempt is reconciled only against the committed event at its own number', () => {
  const MEMBER = '00000000-0000-4000-8000-0000000000e1'
  const ACTOR = '00000000-0000-4000-8000-0000000000d1'
  const committed = facts([basis(), finding()]).map((event) => ({ ...event, recordedByMembershipId: MEMBER, recordedByUserId: ACTOR }))
  const attempt = { ...finding(), sequence: 2, recordedByMembershipId: MEMBER, recordedByUserId: ACTOR }
  assert.deepEqual(reconcileAttempt(committed, attempt), { outcome: 'RECORDED', investigationEventId: idOf(2) })
  assert.deepEqual(reconcileAttempt(committed, { ...attempt, recordedByUserId: '00000000-0000-4000-8000-0000000000d2' }), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt(committed, { ...attempt, recordedByMembershipId: '00000000-0000-4000-8000-0000000000e2' }), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt(committed, { ...finding(idOf(1), 'EVIDENCE_INCONCLUSIVE'), sequence: 2, recordedByMembershipId: MEMBER, recordedByUserId: ACTOR }), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt(committed, { ...triage(), sequence: 3, recordedByMembershipId: MEMBER, recordedByUserId: ACTOR }), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([], { ...basis(), sequence: 1, recordedByMembershipId: MEMBER, recordedByUserId: ACTOR }), { outcome: 'NOT_RECORDED' })
})
