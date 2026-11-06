import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRemediationEvent, deriveRemediation, NO_PROPOSAL, reconcileAttempt } from './exception-remediation.reducer.ts'
import type { RemediationDerived, RemediationEventFacts, RemediationEventShape } from './exception-remediation.types.ts'

// A8.5 — the remediation reducer over every state and event, the whole-history derivation and the unknown-outcome
// reconciliation. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const M1 = id(901)
const U1 = id(911)
const M2 = id(902)
const U2 = id(912)
const F1 = id(801)
const F2 = id(802)
const parent = { exceptionIntakeId: id(1), organizationId: id(2), claimId: id(3) }

const propose = (o: Partial<RemediationEventShape> = {}): RemediationEventShape => ({
  eventCode: 'PROPOSE_ACTION', actionCode: 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', findingEventId: F1, rationaleCode: 'INSUFFICIENT_EVIDENCE',
  proposalEventId: null, decisionCode: null, reviewReasonCode: null, recordedByMembershipId: M1, recordedByUserId: U1, ...o,
})
const review = (proposalEventId: string, decisionCode: string, reviewReasonCode: string | null, o: Partial<RemediationEventShape> = {}): RemediationEventShape => ({
  eventCode: 'REVIEW_ACTION', actionCode: null, findingEventId: null, rationaleCode: null, proposalEventId, decisionCode, reviewReasonCode, recordedByMembershipId: M2, recordedByUserId: U2, ...o,
})
const step = (state: RemediationDerived, event: RemediationEventShape, eventId: string) => {
  const next = applyRemediationEvent(state, event, eventId)
  assert.ok(next.ok, next.ok ? '' : next.detail)
  return next.derived
}
const refused = (state: RemediationDerived, event: RemediationEventShape) => assert.equal(applyRemediationEvent(state, event, id(999)).ok, false, JSON.stringify(event).slice(0, 120))

test('the worked scenario: propose, return, propose afresh, approve (T031, T036, T041–T045)', () => {
  assert.equal(NO_PROPOSAL.state, 'NO_PROPOSAL')
  const p1 = step(NO_PROPOSAL, propose(), id(11))
  assert.equal(p1.state, 'AWAITING_REVIEW')
  assert.equal(p1.pendingProposal?.remediationEventId, id(11))
  const r1 = step(p1, review(id(11), 'RETURN_PROPOSAL', 'NEEDS_MORE_INVESTIGATION'), id(12))
  assert.equal(r1.state, 'RETURNED_FOR_REVISION')
  assert.equal(r1.pendingProposal, null)
  const p2 = step(r1, propose({ actionCode: 'REVIEW_SOURCE_PROVENANCE' }), id(13))
  assert.equal(p2.state, 'AWAITING_REVIEW')
  const a = step(p2, review(id(13), 'APPROVE_PROPOSAL', null), id(14))
  assert.equal(a.state, 'APPROVED_FOR_PLANNING')
  assert.deepEqual(a.decisions.map((d) => [d.proposalEventId, d.decisionCode]), [[id(11), 'RETURN_PROPOSAL'], [id(13), 'APPROVE_PROPOSAL']])
  assert.equal(a.lastSequence, 4)
})

test('every illegal state/event pair is refused (T037, T038, T047–T050)', () => {
  const awaiting = step(NO_PROPOSAL, propose(), id(21))
  const returned = step(awaiting, review(id(21), 'RETURN_PROPOSAL', 'WRONG_SCOPE'), id(22))
  const approved = step(step(returned, propose({ findingEventId: F2 }), id(23)), review(id(23), 'APPROVE_PROPOSAL', null), id(24))
  // NO_PROPOSAL: a review has nothing to review.
  refused(NO_PROPOSAL, review(id(21), 'APPROVE_PROPOSAL', null))
  // AWAITING_REVIEW: a second proposal, a review of another proposal, self-review by membership and by user.
  refused(awaiting, propose({ findingEventId: F2 }))
  refused(awaiting, review(id(77), 'APPROVE_PROPOSAL', null))
  refused(awaiting, review(id(21), 'APPROVE_PROPOSAL', null, { recordedByMembershipId: M1 }))
  refused(awaiting, review(id(21), 'APPROVE_PROPOSAL', null, { recordedByUserId: U1 }))
  // RETURNED_FOR_REVISION: a review (nothing outstanding), an unchanged repeat of the returned proposal.
  refused(returned, review(id(21), 'APPROVE_PROPOSAL', null))
  refused(returned, propose())
  // A change of any one field makes it a fresh proposal.
  for (const fresh of [propose({ actionCode: 'REFER_FOR_POLICY_REVIEW' }), propose({ findingEventId: F2 }), propose({ rationaleCode: 'RECORDED_CONFLICT' })]) assert.equal(applyRemediationEvent(returned, fresh, id(30)).ok, true)
  // APPROVED_FOR_PLANNING is terminal: no proposal and no review.
  refused(approved, propose({ actionCode: 'RECHECK_CODING_REFERENCE' }))
  refused(approved, review(id(23), 'RETURN_PROPOSAL', 'INSUFFICIENT_SUPPORT'))
})

test('event shapes are exact (T012, T013, T017–T019, T057)', () => {
  for (const bad of [
    propose({ actionCode: 'EXECUTE_REMEDIATION' }), propose({ actionCode: null }), propose({ findingEventId: 'not-a-uuid' }), propose({ findingEventId: null }), propose({ rationaleCode: 'BECAUSE' }),
    propose({ proposalEventId: id(5) }), propose({ decisionCode: 'APPROVE_PROPOSAL' }), propose({ reviewReasonCode: 'WRONG_SCOPE' }), propose({ recordedByMembershipId: 'x' }), propose({ eventCode: 'EXECUTE_ACTION' }),
  ])
    refused(NO_PROPOSAL, bad)
  const awaiting = step(NO_PROPOSAL, propose(), id(41))
  for (const bad of [
    review(id(41), 'APPROVE_PROPOSAL', 'WRONG_SCOPE'), review(id(41), 'RETURN_PROPOSAL', null), review(id(41), 'RETURN_PROPOSAL', 'BECAUSE'), review(id(41), 'MAYBE', null), review('nope', 'APPROVE_PROPOSAL', null),
    review(id(41), 'APPROVE_PROPOSAL', null, { actionCode: 'REVIEW_SOURCE_PROVENANCE' }), review(id(41), 'APPROVE_PROPOSAL', null, { findingEventId: F1 }), review(id(41), 'APPROVE_PROPOSAL', null, { rationaleCode: 'RECORDED_CONFLICT' }),
  ])
    refused(awaiting, bad)
})

const facts = (n: number, event: RemediationEventShape, o: Partial<RemediationEventFacts> = {}): RemediationEventFacts => ({ ...event, id: id(100 + n), ...parent, contractVersion: 'A8-REMEDIATION-PLAN-1', sequence: n, ...o })

test('a whole stored history derives deterministically or is refused entirely (T082, T084–T086)', () => {
  const history = [facts(1, propose()), facts(2, review(id(101), 'RETURN_PROPOSAL', 'INSUFFICIENT_SUPPORT')), facts(3, propose({ findingEventId: F2 })), facts(4, review(id(103), 'APPROVE_PROPOSAL', null))]
  const first = JSON.stringify(deriveRemediation(parent, history))
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(deriveRemediation(parent, history)), first)
  const derived = deriveRemediation(parent, history)
  assert.ok(derived.ok)
  assert.equal(derived.value.state, 'APPROVED_FOR_PLANNING')
  assert.deepEqual(deriveRemediation(parent, []), { ok: true, value: NO_PROPOSAL })
  for (const broken of [
    [facts(2, propose())], [facts(1, propose()), facts(3, review(id(101), 'APPROVE_PROPOSAL', null))], [facts(1, propose()), facts(1, review(id(101), 'APPROVE_PROPOSAL', null))],
    [facts(1, propose(), { contractVersion: 'A8-REMEDIATION-PLAN-0' })], [facts(1, propose(), { claimId: id(9) })], [facts(1, propose(), { organizationId: id(9) })], [facts(1, propose(), { exceptionIntakeId: id(9) })],
    [facts(1, propose(), { id: 'x' })], [facts(1, propose({ actionCode: 'DELETE_EVERYTHING' }))], [facts(1, propose()), facts(2, review(id(101), 'APPROVE_PROPOSAL', null, { recordedByUserId: U1 }))],
  ])
    assert.equal(deriveRemediation(parent, broken).ok, false, JSON.stringify(broken).slice(0, 140))
})

test('an unknown outcome is reconciled against the committed history only (T079)', () => {
  const attempted = { ...propose(), sequence: 1 }
  assert.deepEqual(reconcileAttempt([], attempted), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([{ ...propose(), id: id(61), sequence: 1 }], attempted), { outcome: 'RECORDED', remediationEventId: id(61) })
  assert.deepEqual(reconcileAttempt([{ ...propose({ rationaleCode: 'RECORDED_CONFLICT' }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...propose({ recordedByUserId: U2 }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...propose(), id: id(61), sequence: 2 }], attempted), { outcome: 'NOT_RECORDED' })
})
