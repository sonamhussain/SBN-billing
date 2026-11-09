import test from 'node:test'
import assert from 'node:assert/strict'
import { applyWorkEvent, deriveWork, NO_WORK_REPORT, reconcileAttempt, workCodeForAction } from './exception-remediation-work.reducer.ts'
import type { ApprovedPlan, WorkDerived, WorkEventFacts, WorkEventShape } from './exception-remediation-work.types.ts'

// A8.6 — the work reducer over every state and event, the 1:1 work-code mapping, the whole-history derivation and the
// unknown-outcome reconciliation. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const M1 = id(901)
const U1 = id(911)
const M2 = id(902)
const U2 = id(912)
const P1 = id(701)
const E1 = id(801)
const E2 = id(802)
const parent = { exceptionIntakeId: id(1), organizationId: id(2), claimId: id(3) }
const plan: ApprovedPlan = { approvedProposalEventId: P1, actionCode: 'REQUEST_INTERNAL_DOCUMENTATION_CHECK' }

const report = (o: Partial<WorkEventShape> = {}): WorkEventShape => ({
  eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId: P1, workCode: 'DOCUMENTATION_CHECK_REPORTED', basisReferenceKind: 'INVESTIGATION_FINDING', basisReferenceId: E1,
  basisReferenceContractVersion: 'A8-EXCEPTION-INVESTIGATION-1', workReportEventId: null, verificationCode: null, reasonCode: null, recordedByMembershipId: M1, recordedByUserId: U1, ...o,
})
const verify = (workReportEventId: string, verificationCode: string, reasonCode: string | null, o: Partial<WorkEventShape> = {}): WorkEventShape => ({
  eventCode: 'VERIFY_WORK_REPORT', approvedProposalEventId: P1, workCode: null, basisReferenceKind: null, basisReferenceId: null, basisReferenceContractVersion: null,
  workReportEventId, verificationCode, reasonCode, recordedByMembershipId: M2, recordedByUserId: U2, ...o,
})
const step = (state: WorkDerived, event: WorkEventShape, eventId: string, p: ApprovedPlan | null = plan) => {
  const next = applyWorkEvent(state, p, event, eventId)
  assert.ok(next.ok, next.ok ? '' : next.detail)
  return next.derived
}
const refused = (state: WorkDerived, event: WorkEventShape, p: ApprovedPlan | null = plan) => assert.equal(applyWorkEvent(state, p, event, id(999)).ok, false, JSON.stringify(event).slice(0, 140))

test('the worked scenarios: report then supported, report then not verified (T031, T038, T041–T043)', () => {
  assert.equal(NO_WORK_REPORT.state, 'NO_WORK_REPORT')
  const awaiting = step(NO_WORK_REPORT, report(), id(11))
  assert.equal(awaiting.state, 'AWAITING_VERIFICATION')
  assert.equal(awaiting.report?.workEventId, id(11))
  assert.equal(awaiting.report?.approvedProposalEventId, P1)
  const supported = step(awaiting, verify(id(11), 'EVIDENCE_SUPPORTED', null), id(12))
  assert.equal(supported.state, 'VERIFIED_INTERNAL_WORK')
  assert.equal(supported.verification?.reasonCode, null)
  assert.equal(supported.lastSequence, 2)
  const notVerified = step(step(NO_WORK_REPORT, report({ basisReferenceKind: 'INVESTIGATION_EVIDENCE_LINK', basisReferenceId: E2 }), id(21)), verify(id(21), 'EVIDENCE_NOT_VERIFIED', 'SOURCE_MISMATCH'), id(22))
  assert.equal(notVerified.state, 'NOT_VERIFIED')
  assert.equal(notVerified.verification?.reasonCode, 'SOURCE_MISMATCH')
  // The A8.5 approver may verify (D7): independence is judged against the reporter only.
  assert.equal(applyWorkEvent(awaiting, plan, verify(id(11), 'EVIDENCE_SUPPORTED', null, { recordedByMembershipId: id(903), recordedByUserId: id(913) }), id(13)).ok, true)
})

test('the work code is exactly the approved action’s, 1:1 (T037)', () => {
  const pairs: [string, string][] = [
    ['REVIEW_SOURCE_PROVENANCE', 'SOURCE_PROVENANCE_REVIEWED'],
    ['REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'DOCUMENTATION_CHECK_REPORTED'],
    ['RECHECK_CODING_REFERENCE', 'CODING_REFERENCE_REVIEW_REPORTED'],
    ['REFER_FOR_POLICY_REVIEW', 'POLICY_REVIEW_REFERRED'],
  ]
  for (const [action, work] of pairs) {
    assert.equal(workCodeForAction(action), work)
    const p = { approvedProposalEventId: P1, actionCode: action }
    assert.equal(applyWorkEvent(NO_WORK_REPORT, p, report({ workCode: work }), id(31)).ok, true)
    for (const [, other] of pairs.filter(([a]) => a !== action)) refused(NO_WORK_REPORT, report({ workCode: other }), p)
  }
  assert.equal(workCodeForAction('EXECUTE_REMEDIATION'), null)
  assert.equal(workCodeForAction('toString'), null)
  refused(NO_WORK_REPORT, report(), { approvedProposalEventId: P1, actionCode: 'EXECUTE_REMEDIATION' })
})

test('every illegal state/event pair is refused (T032, T039, T040, T044–T048)', () => {
  const awaiting = step(NO_WORK_REPORT, report(), id(41))
  const supported = step(awaiting, verify(id(41), 'EVIDENCE_SUPPORTED', null), id(42))
  const notVerified = step(awaiting, verify(id(41), 'EVIDENCE_NOT_VERIFIED', 'INSUFFICIENT_SUPPORT'), id(43))
  // No approved plan, or another plan: nothing is recorded (an approval is never inferred).
  refused(NO_WORK_REPORT, report(), null)
  refused(NO_WORK_REPORT, report({ approvedProposalEventId: id(702) }))
  refused(awaiting, verify(id(41), 'EVIDENCE_SUPPORTED', null, { approvedProposalEventId: id(702) }))
  // NO_WORK_REPORT: a verification has nothing to verify.
  refused(NO_WORK_REPORT, verify(id(41), 'EVIDENCE_SUPPORTED', null))
  // AWAITING_VERIFICATION: a second report (also an exact duplicate), a verification of another report, self-verification
  // by membership and by user.
  refused(awaiting, report())
  refused(awaiting, report({ basisReferenceId: E2 }))
  refused(awaiting, verify(id(77), 'EVIDENCE_SUPPORTED', null))
  refused(awaiting, verify(id(41), 'EVIDENCE_SUPPORTED', null, { recordedByMembershipId: M1 }))
  refused(awaiting, verify(id(41), 'EVIDENCE_SUPPORTED', null, { recordedByUserId: U1 }))
  // Both verifications are terminal: no further report and no second verification.
  for (const terminal of [supported, notVerified]) {
    refused(terminal, report())
    refused(terminal, report({ basisReferenceId: E2 }))
    refused(terminal, verify(id(41), 'EVIDENCE_SUPPORTED', null))
    refused(terminal, verify(id(41), 'EVIDENCE_NOT_VERIFIED', 'SOURCE_MISSING'))
  }
})

test('event shapes are exact (T012, T013, T017–T019, T057)', () => {
  for (const bad of [
    report({ workCode: 'CLAIM_CORRECTED' }), report({ workCode: null }), report({ basisReferenceKind: 'ATTACHMENT' }), report({ basisReferenceKind: null }), report({ basisReferenceId: 'not-a-uuid' }),
    report({ basisReferenceContractVersion: 'A8-EXCEPTION-INVESTIGATION-0' }), report({ basisReferenceContractVersion: null }), report({ approvedProposalEventId: null }), report({ workReportEventId: id(5) }),
    report({ verificationCode: 'EVIDENCE_SUPPORTED' }), report({ reasonCode: 'SOURCE_MISSING' }), report({ recordedByMembershipId: 'x' }), report({ eventCode: 'RESOLVE_EXCEPTION' }),
  ])
    refused(NO_WORK_REPORT, bad)
  const awaiting = step(NO_WORK_REPORT, report(), id(51))
  for (const bad of [
    verify(id(51), 'EVIDENCE_SUPPORTED', 'SOURCE_MISSING'), verify(id(51), 'EVIDENCE_NOT_VERIFIED', null), verify(id(51), 'EVIDENCE_NOT_VERIFIED', 'BECAUSE'), verify(id(51), 'RESOLVED', null), verify('nope', 'EVIDENCE_SUPPORTED', null),
    verify(id(51), 'EVIDENCE_SUPPORTED', null, { approvedProposalEventId: null }), verify(id(51), 'EVIDENCE_SUPPORTED', null, { workCode: 'DOCUMENTATION_CHECK_REPORTED' }),
    verify(id(51), 'EVIDENCE_SUPPORTED', null, { basisReferenceKind: 'INVESTIGATION_FINDING' }), verify(id(51), 'EVIDENCE_SUPPORTED', null, { basisReferenceId: E1 }),
    verify(id(51), 'EVIDENCE_SUPPORTED', null, { basisReferenceContractVersion: 'A8-EXCEPTION-INVESTIGATION-1' }),
  ])
    refused(awaiting, bad)
})

const facts = (n: number, event: WorkEventShape, o: Partial<WorkEventFacts> = {}): WorkEventFacts => ({ ...event, id: id(100 + n), ...parent, contractVersion: 'A8-REMEDIATION-WORK-1', sequence: n, ...o })

test('a whole stored history derives deterministically or is refused entirely (T082, T084–T086)', () => {
  const history = [facts(1, report()), facts(2, verify(id(101), 'EVIDENCE_SUPPORTED', null))]
  const first = JSON.stringify(deriveWork(parent, plan, history))
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(deriveWork(parent, plan, history)), first)
  const derived = deriveWork(parent, plan, history)
  assert.ok(derived.ok)
  assert.equal(derived.value.state, 'VERIFIED_INTERNAL_WORK')
  assert.deepEqual(deriveWork(parent, plan, []), { ok: true, value: NO_WORK_REPORT })
  assert.deepEqual(deriveWork(parent, null, []), { ok: true, value: NO_WORK_REPORT })
  for (const [p, broken] of [
    [plan, [facts(2, report())]],
    [plan, [facts(1, report()), facts(3, verify(id(101), 'EVIDENCE_SUPPORTED', null))]],
    [plan, [facts(1, report()), facts(1, verify(id(101), 'EVIDENCE_SUPPORTED', null))]],
    [plan, [facts(1, report(), { contractVersion: 'A8-REMEDIATION-WORK-0' })]],
    [plan, [facts(1, report(), { claimId: id(9) })]],
    [plan, [facts(1, report(), { organizationId: id(9) })]],
    [plan, [facts(1, report(), { exceptionIntakeId: id(9) })]],
    [plan, [facts(1, report(), { id: 'x' })]],
    [plan, [facts(1, report({ workCode: 'CLAIM_CORRECTED' }))]],
    [plan, [facts(1, report()), facts(2, verify(id(101), 'EVIDENCE_SUPPORTED', null, { recordedByUserId: U1 }))]],
    [plan, [facts(1, report()), facts(2, verify(id(101), 'EVIDENCE_SUPPORTED', null)), facts(3, report())]],
    // Stored work with no approved plan, or against another plan, is inconsistent.
    [null, [facts(1, report())]],
    [{ approvedProposalEventId: id(702), actionCode: 'REQUEST_INTERNAL_DOCUMENTATION_CHECK' }, [facts(1, report())]],
  ] as [ApprovedPlan | null, WorkEventFacts[]][])
    assert.equal(deriveWork(parent, p, broken).ok, false, JSON.stringify(broken).slice(0, 140))
})

test('an unknown outcome is reconciled against the committed history only (T080)', () => {
  const attempted = { ...report(), sequence: 1 }
  assert.deepEqual(reconcileAttempt([], attempted), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([{ ...report(), id: id(61), sequence: 1 }], attempted), { outcome: 'RECORDED', workEventId: id(61) })
  assert.deepEqual(reconcileAttempt([{ ...report({ basisReferenceId: E2 }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...report({ recordedByUserId: U2 }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...report(), id: id(61), sequence: 2 }], attempted), { outcome: 'NOT_RECORDED' })
})
