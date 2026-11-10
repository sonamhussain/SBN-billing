import test from 'node:test'
import assert from 'node:assert/strict'
import { applyResolutionEvent, deriveResolution, NO_RESOLUTION_REQUEST, reconcileAttempt, verifiedBasisOf } from './exception-resolution.reducer.ts'
import type { PlanDispositionFacts, ResolutionDerived, ResolutionEventFacts, ResolutionEventShape, VerifiedBasis, WorkDispositionFacts } from './exception-resolution.types.ts'

// A8.7 — the resolution reducer over every state and event, the verified A8.6 basis, the whole-history derivation and
// the unknown-outcome reconciliation. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const M1 = id(901)
const U1 = id(911)
const M2 = id(902)
const U2 = id(912)
const V1 = id(801)
const V2 = id(802)
const parent = { exceptionIntakeId: id(1), organizationId: id(2), claimId: id(3) }
const basis: VerifiedBasis = { verificationEventId: V1, workReportEventId: id(811), approvedProposalEventId: id(701) }
const plan: PlanDispositionFacts = { state: 'APPROVED_FOR_PLANNING', approvedProposalEventId: id(701) }

const request = (o: Partial<ResolutionEventShape> = {}): ResolutionEventShape => ({
  eventCode: 'REQUEST_INTERNAL_RESOLUTION', verificationEventId: V1, requestEventId: null, reasonCode: 'VERIFIED_INTERNAL_WORK', decisionCode: null, returnReasonCode: null,
  recordedByMembershipId: M1, recordedByUserId: U1, ...o,
})
const decide = (requestEventId: string, decisionCode: string, returnReasonCode: string | null, o: Partial<ResolutionEventShape> = {}): ResolutionEventShape => ({
  eventCode: 'DECIDE_INTERNAL_RESOLUTION', verificationEventId: null, requestEventId, reasonCode: null, decisionCode, returnReasonCode, recordedByMembershipId: M2, recordedByUserId: U2, ...o,
})
const step = (state: ResolutionDerived, event: ResolutionEventShape, eventId: string, b: VerifiedBasis | null = basis) => {
  const next = applyResolutionEvent(state, b, event, eventId)
  assert.ok(next.ok, next.ok ? '' : next.detail)
  return next.derived
}
const refused = (state: ResolutionDerived, event: ResolutionEventShape, refusal: string, b: VerifiedBasis | null = basis) => {
  const next = applyResolutionEvent(state, b, event, id(999))
  assert.equal(next.ok, false, JSON.stringify(event).slice(0, 140))
  if (!next.ok) assert.equal(next.refusal, refusal, next.detail)
}

test('the verified A8.6 basis is read exactly as recorded, on the same approved A8.5 plan (T034, T035, T036)', () => {
  const verified: WorkDispositionFacts = {
    state: 'VERIFIED_INTERNAL_WORK',
    approvedProposalEventId: id(701),
    verification: { workEventId: V1, sequence: 2, workReportEventId: id(811), verificationCode: 'EVIDENCE_SUPPORTED', reasonCode: null, verifiedByMembershipId: M2, verifiedByUserId: U2 },
  }
  assert.deepEqual(verifiedBasisOf(verified, plan), basis)
  // NOT_VERIFIED, a pending report, no work and an inconsistent disposition are never a basis.
  assert.equal(verifiedBasisOf({ ...verified, state: 'NOT_VERIFIED', verification: { ...verified.verification!, verificationCode: 'EVIDENCE_NOT_VERIFIED', reasonCode: 'SOURCE_MISMATCH' } }, plan), null)
  assert.equal(verifiedBasisOf({ ...verified, state: 'AWAITING_VERIFICATION', verification: null }, plan), null)
  assert.equal(verifiedBasisOf({ state: 'NO_WORK_REPORT', approvedProposalEventId: null, verification: null }, plan), null)
  assert.equal(verifiedBasisOf({ ...verified, verification: { ...verified.verification!, verificationCode: 'EVIDENCE_NOT_VERIFIED', reasonCode: 'SOURCE_MISSING' } }, plan), null)
  assert.equal(verifiedBasisOf({ ...verified, approvedProposalEventId: null }, plan), null)
  // The A8.6 work must sit on exactly the plan A8.5 reports as approved.
  assert.equal(verifiedBasisOf(verified, { ...plan, approvedProposalEventId: id(702) }), null)
  assert.equal(verifiedBasisOf(verified, { state: 'AWAITING_REVIEW', approvedProposalEventId: null }), null)
  assert.equal(verifiedBasisOf(verified, { state: 'RETURNED_FOR_REVISION', approvedProposalEventId: id(701) }), null)
})

test('the worked scenarios: request then confirm, request then return (T031, T038, T041–T047)', () => {
  assert.equal(NO_RESOLUTION_REQUEST.state, 'NO_RESOLUTION_REQUEST')
  const awaiting = step(NO_RESOLUTION_REQUEST, request(), id(11))
  assert.equal(awaiting.state, 'AWAITING_RESOLUTION_DECISION')
  assert.equal(awaiting.request?.resolutionEventId, id(11))
  assert.equal(awaiting.request?.verificationEventId, V1)
  const resolved = step(awaiting, decide(id(11), 'CONFIRM_INTERNAL_RESOLUTION', null), id(12))
  assert.equal(resolved.state, 'RESOLVED_INTERNAL')
  assert.equal(resolved.decision?.returnReasonCode, null)
  assert.equal(resolved.lastSequence, 2)
  const returned = step(awaiting, decide(id(11), 'RETURN_FOR_REWORK', 'ADDITIONAL_WORK_REQUIRED'), id(13))
  assert.equal(returned.state, 'RETURNED_FOR_REWORK')
  assert.equal(returned.decision?.returnReasonCode, 'ADDITIONAL_WORK_REQUIRED')
  // A return is never a resolution, and the returned request stays the recorded one.
  assert.notEqual(returned.state, 'RESOLVED_INTERNAL')
  assert.equal(returned.request?.resolutionEventId, id(11))
  // D5: independence is judged against the requester only; another member (also the A8.6 verifier) may decide.
  assert.equal(applyResolutionEvent(awaiting, basis, decide(id(11), 'CONFIRM_INTERNAL_RESOLUTION', null, { recordedByMembershipId: id(903), recordedByUserId: id(913) }), id(14)).ok, true)
})

test('RETURNED_FOR_REWORK is terminal in v1: any new request after a return is refused (T048, T049)', () => {
  const returned = step(step(NO_RESOLUTION_REQUEST, request(), id(21)), decide(id(21), 'RETURN_FOR_REWORK', 'INSUFFICIENT_SUPPORT'), id(22))
  // The same evidence, another actor, another record, and even a NEW verified record: all refused (409).
  refused(returned, request(), 'TRANSITION_REFUSED')
  refused(returned, request({ recordedByMembershipId: M2, recordedByUserId: U2 }), 'TRANSITION_REFUSED')
  refused(returned, request({ verificationEventId: V2 }), 'TRANSITION_REFUSED')
  refused(returned, request({ verificationEventId: V2 }), 'TRANSITION_REFUSED', { ...basis, verificationEventId: V2 })
  refused(returned, decide(id(21), 'CONFIRM_INTERNAL_RESOLUTION', null), 'TRANSITION_REFUSED')
})

test('every illegal state/event pair is refused (T051–T057)', () => {
  const awaiting = step(NO_RESOLUTION_REQUEST, request(), id(41))
  const resolved = step(awaiting, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null), id(42))
  // No verified A8.6 record, or another one: nothing is requested (a resolution is never inferred from A8.6).
  refused(NO_RESOLUTION_REQUEST, request(), 'BASIS_NOT_VERIFIED', null)
  refused(NO_RESOLUTION_REQUEST, request({ verificationEventId: V2 }), 'BASIS_NOT_VERIFIED')
  // NO_RESOLUTION_REQUEST: a decision has nothing to decide.
  refused(NO_RESOLUTION_REQUEST, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null), 'TRANSITION_REFUSED')
  // AWAITING: a second request (also an exact duplicate), a decision of another request, a self-decision by membership
  // and by user, and a decision whose basis is no longer the verified record (D6).
  refused(awaiting, request(), 'TRANSITION_REFUSED')
  refused(awaiting, decide(id(77), 'CONFIRM_INTERNAL_RESOLUTION', null), 'TRANSITION_REFUSED')
  refused(awaiting, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null, { recordedByMembershipId: M1 }), 'REVIEWER_NOT_INDEPENDENT')
  refused(awaiting, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null, { recordedByUserId: U1 }), 'REVIEWER_NOT_INDEPENDENT')
  refused(awaiting, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null), 'BASIS_NOT_VERIFIED', null)
  refused(awaiting, decide(id(41), 'RETURN_FOR_REWORK', 'SOURCE_INTEGRITY_CONCERN'), 'BASIS_NOT_VERIFIED', { ...basis, verificationEventId: V2 })
  // RESOLVED_INTERNAL is terminal: no new request and no second decision.
  refused(resolved, request(), 'TRANSITION_REFUSED')
  refused(resolved, request({ verificationEventId: V2 }), 'TRANSITION_REFUSED', { ...basis, verificationEventId: V2 })
  refused(resolved, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null), 'TRANSITION_REFUSED')
  refused(resolved, decide(id(41), 'RETURN_FOR_REWORK', 'INSUFFICIENT_SUPPORT'), 'TRANSITION_REFUSED')
  // RETURNED_FOR_REWORK is terminal too: no second decision and no new request.
  const returned = step(awaiting, decide(id(41), 'RETURN_FOR_REWORK', 'INSUFFICIENT_SUPPORT'), id(43))
  refused(returned, decide(id(41), 'CONFIRM_INTERNAL_RESOLUTION', null), 'TRANSITION_REFUSED')
  refused(returned, decide(id(41), 'RETURN_FOR_REWORK', 'ADDITIONAL_WORK_REQUIRED'), 'TRANSITION_REFUSED')
  refused(returned, request(), 'TRANSITION_REFUSED')
})

test('event shapes are exact (T012, T013, T017–T019, T067)', () => {
  for (const bad of [
    request({ reasonCode: 'BECAUSE' }), request({ reasonCode: null }), request({ verificationEventId: null }), request({ verificationEventId: 'not-a-uuid' }), request({ requestEventId: id(5) }),
    request({ decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }), request({ returnReasonCode: 'INSUFFICIENT_SUPPORT' }), request({ recordedByMembershipId: 'x' }), request({ recordedByUserId: '' }),
    request({ eventCode: 'CLOSE_EXCEPTION' }),
  ])
    refused(NO_RESOLUTION_REQUEST, bad, 'SHAPE')
  const awaiting = step(NO_RESOLUTION_REQUEST, request(), id(51))
  for (const bad of [
    decide(id(51), 'CONFIRM_INTERNAL_RESOLUTION', 'INSUFFICIENT_SUPPORT'), decide(id(51), 'RETURN_FOR_REWORK', null), decide(id(51), 'RETURN_FOR_REWORK', 'BECAUSE'), decide(id(51), 'RESOLVED', null),
    decide('nope', 'CONFIRM_INTERNAL_RESOLUTION', null), decide(id(51), 'CONFIRM_INTERNAL_RESOLUTION', null, { verificationEventId: V1 }),
    decide(id(51), 'CONFIRM_INTERNAL_RESOLUTION', null, { reasonCode: 'VERIFIED_INTERNAL_WORK' }),
  ])
    refused(awaiting, bad, 'SHAPE')
})

const facts = (n: number, event: ResolutionEventShape, o: Partial<ResolutionEventFacts> = {}): ResolutionEventFacts => ({
  ...event, id: id(100 + n), ...parent, contractVersion: 'A8-RESOLUTION-DECISION-1', sequence: n, ...o,
})

test('a whole stored history derives deterministically or is refused entirely (T091–T097)', () => {
  const history = [facts(1, request()), facts(2, decide(id(101), 'CONFIRM_INTERNAL_RESOLUTION', null))]
  const first = JSON.stringify(deriveResolution(parent, basis, history))
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(deriveResolution(parent, basis, history)), first)
  const derived = deriveResolution(parent, basis, history)
  assert.ok(derived.ok)
  assert.equal(derived.value.state, 'RESOLVED_INTERNAL')
  assert.deepEqual(deriveResolution(parent, basis, []), { ok: true, value: NO_RESOLUTION_REQUEST })
  assert.deepEqual(deriveResolution(parent, null, []), { ok: true, value: NO_RESOLUTION_REQUEST })
  const returnedHistory = [facts(1, request()), facts(2, decide(id(101), 'RETURN_FOR_REWORK', 'ADDITIONAL_WORK_REQUIRED'))]
  const returned = deriveResolution(parent, basis, returnedHistory)
  assert.ok(returned.ok)
  assert.equal(returned.value.state, 'RETURNED_FOR_REWORK')
  for (const [b, broken] of [
    [basis, [facts(2, request())]],
    [basis, [facts(1, request()), facts(3, decide(id(101), 'CONFIRM_INTERNAL_RESOLUTION', null))]],
    [basis, [facts(1, request()), facts(1, decide(id(101), 'CONFIRM_INTERNAL_RESOLUTION', null))]],
    [basis, [facts(1, request(), { contractVersion: 'A8-RESOLUTION-DECISION-0' })]],
    [basis, [facts(1, request(), { claimId: id(9) })]],
    [basis, [facts(1, request(), { organizationId: id(9) })]],
    [basis, [facts(1, request(), { exceptionIntakeId: id(9) })]],
    [basis, [facts(1, request(), { id: 'x' })]],
    [basis, [facts(1, request({ reasonCode: 'BECAUSE' }))]],
    [basis, [facts(1, request()), facts(2, decide(id(101), 'CONFIRM_INTERNAL_RESOLUTION', null, { recordedByUserId: U1 }))]],
    [basis, [facts(1, request()), facts(2, decide(id(101), 'CONFIRM_INTERNAL_RESOLUTION', null)), facts(3, request())]],
    [basis, [...returnedHistory, facts(3, request())]],
    // A stored request without a verified basis, or against another record, is inconsistent.
    [null, [facts(1, request())]],
    [{ ...basis, verificationEventId: V2 }, [facts(1, request())]],
  ] as [VerifiedBasis | null, ResolutionEventFacts[]][])
    assert.equal(deriveResolution(parent, b, broken).ok, false, JSON.stringify(broken).slice(0, 140))
})

test('an unknown outcome is reconciled against the committed history only (T089)', () => {
  const attempted = { ...request(), sequence: 1 }
  assert.deepEqual(reconcileAttempt([], attempted), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([{ ...request(), id: id(61), sequence: 1 }], attempted), { outcome: 'RECORDED', resolutionEventId: id(61) })
  assert.deepEqual(reconcileAttempt([{ ...request({ verificationEventId: V2 }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...request({ recordedByUserId: U2 }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...request(), id: id(61), sequence: 2 }], attempted), { outcome: 'NOT_RECORDED' })
})
