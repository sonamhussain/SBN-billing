import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEscalationEvent, deriveEscalation, NO_ESCALATION, reconcileAttempt, upstreamRefusal } from './exception-escalation.reducer.ts'
import type { EscalationDerived, EscalationEventFacts, EscalationEventShape } from './exception-escalation.types.ts'
import { escalationEventCodes } from './exception-escalation.types.ts'

// A8.8 — the escalation reducer over every state and event, the A8.7 gate, the whole-history derivation and the
// unknown-outcome reconciliation. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const M1 = id(901) // escalator (the A8.2 assignee)
const U1 = id(911)
const T = id(902) // nominated target
const UT = id(912)
const R = id(903) // independent reviewer
const UR = id(913)
const S1 = id(801)
const S2 = id(802)
const parent = { exceptionIntakeId: id(1), organizationId: id(2), claimId: id(3) }

const base = (o: Partial<EscalationEventShape>): EscalationEventShape => ({
  eventCode: 'ESCALATE_FOR_REVIEW', reasonCode: null, targetMemberId: null, escalationEventId: null, acknowledgementEventId: null, followupCode: null, sourceEventId: null,
  sourceEventKind: null, returnReasonCode: null, recordedByMembershipId: M1, recordedByUserId: U1, ...o,
})
const escalate = (o: Partial<EscalationEventShape> = {}) => base({ eventCode: 'ESCALATE_FOR_REVIEW', reasonCode: 'NEEDS_SUPERVISOR_REVIEW', targetMemberId: T, ...o })
const ack = (escalationEventId: string, o: Partial<EscalationEventShape> = {}) => base({ eventCode: 'ACKNOWLEDGE_ESCALATION', escalationEventId, recordedByMembershipId: T, recordedByUserId: UT, ...o })
const followup = (acknowledgementEventId: string, o: Partial<EscalationEventShape> = {}) =>
  base({ eventCode: 'RECORD_FOLLOWUP', acknowledgementEventId, followupCode: 'SOURCE_RECHECK_RECORDED', sourceEventId: S1, sourceEventKind: 'INVESTIGATION_FINDING', recordedByMembershipId: T, recordedByUserId: UT, ...o })
const ret = (escalationEventId: string, o: Partial<EscalationEventShape> = {}) =>
  base({ eventCode: 'RETURN_TO_OWNER', escalationEventId, returnReasonCode: 'FOLLOWUP_RECORDED', recordedByMembershipId: R, recordedByUserId: UR, ...o })

const step = (state: EscalationDerived, event: EscalationEventShape, eventId: string) => {
  const next = applyEscalationEvent(state, event, eventId)
  assert.ok(next.ok, next.ok ? '' : next.detail)
  return next.derived
}
const refused = (state: EscalationDerived, event: EscalationEventShape, refusal: string) => {
  const next = applyEscalationEvent(state, event, id(999))
  assert.equal(next.ok, false, JSON.stringify(event).slice(0, 160))
  if (!next.ok) assert.equal(next.refusal, refusal, next.detail)
}

const awaiting = () => step(NO_ESCALATION, escalate(), id(11))
const active = () => step(awaiting(), ack(id(11)), id(12))
const withFollowup = () => step(active(), followup(id(12)), id(13))

test('the worked cycle: escalate, acknowledge, two distinct follow-ups, return (T031, T041–T049)', () => {
  assert.equal(NO_ESCALATION.state, 'NO_ESCALATION')
  const a = awaiting()
  assert.equal(a.state, 'AWAITING_ACKNOWLEDGEMENT')
  assert.equal(a.escalation?.targetMemberId, T)
  assert.equal(a.escalation?.escalatedByMembershipId, M1)
  const f = active()
  assert.equal(f.state, 'FOLLOWUP_ACTIVE')
  assert.equal(f.acknowledgement?.acknowledgedByUserId, UT)
  const one = withFollowup()
  assert.equal(one.state, 'FOLLOWUP_ACTIVE')
  assert.equal(one.followups.length, 1)
  // A second follow-up is allowed when it is distinct: another code, or the same code citing another record.
  const two = step(one, followup(id(12), { followupCode: 'INTERNAL_POLICY_REVIEWED' }), id(14))
  const three = step(two, followup(id(12), { sourceEventId: S2, sourceEventKind: 'WORK_VERIFICATION' }), id(15))
  assert.equal(three.followups.length, 3)
  assert.deepEqual(three.followups.map((x) => x.sequence), [3, 4, 5])
  const returned = step(three, ret(id(11)), id(16))
  assert.equal(returned.state, 'RETURNED_TO_OWNER')
  assert.equal(returned.returned?.returnReasonCode, 'FOLLOWUP_RECORDED')
  assert.equal(returned.lastSequence, 6)
  // The recorded escalation and follow-ups stay as recorded after the return.
  assert.equal(returned.escalation?.escalationEventId, id(11))
  assert.equal(returned.followups.length, 3)
})

test('RETURNED_TO_OWNER is terminal in v1: every event after the return is refused (T048, T059)', () => {
  const returned = step(withFollowup(), ret(id(11), { returnReasonCode: 'FURTHER_WORK_REQUIRED' }), id(16))
  refused(returned, escalate(), 'TRANSITION_REFUSED')
  refused(returned, escalate({ recordedByMembershipId: R, recordedByUserId: UR, targetMemberId: M1 }), 'TRANSITION_REFUSED')
  refused(returned, ack(id(11)), 'TRANSITION_REFUSED')
  refused(returned, followup(id(12), { followupCode: 'ADDITIONAL_INFORMATION_REQUESTED' }), 'TRANSITION_REFUSED')
  refused(returned, ret(id(11)), 'TRANSITION_REFUSED')
})

test('every illegal state/event pair is refused (T051–T058)', () => {
  // NO_ESCALATION: nothing to acknowledge, follow up or return.
  refused(NO_ESCALATION, ack(id(11)), 'TRANSITION_REFUSED')
  refused(NO_ESCALATION, followup(id(12)), 'TRANSITION_REFUSED')
  refused(NO_ESCALATION, ret(id(11)), 'TRANSITION_REFUSED')
  // An escalation never nominates its own escalator.
  refused(NO_ESCALATION, escalate({ targetMemberId: M1 }), 'NOT_INDEPENDENT')
  // AWAITING: a second escalation, a follow-up or return before acknowledgement, an acknowledgement of another
  // escalation, by the escalator (membership or user) or by anyone but the target.
  const a = awaiting()
  refused(a, escalate(), 'TRANSITION_REFUSED')
  refused(a, escalate({ recordedByMembershipId: R, recordedByUserId: UR }), 'TRANSITION_REFUSED')
  refused(a, followup(id(12)), 'TRANSITION_REFUSED')
  refused(a, ret(id(11)), 'TRANSITION_REFUSED')
  refused(a, ack(id(77)), 'TRANSITION_REFUSED')
  refused(a, ack(id(11), { recordedByMembershipId: M1, recordedByUserId: U1 }), 'NOT_INDEPENDENT')
  refused(a, ack(id(11), { recordedByUserId: U1 }), 'NOT_INDEPENDENT')
  refused(a, ack(id(11), { recordedByMembershipId: R, recordedByUserId: UR }), 'TARGET_NOT_ELIGIBLE')
  // FOLLOWUP_ACTIVE: a second acknowledgement, a second escalation, a follow-up of another acknowledgement or by
  // anyone but the acknowledging target, a return before any follow-up.
  const f = active()
  refused(f, ack(id(11)), 'TRANSITION_REFUSED')
  refused(f, escalate(), 'TRANSITION_REFUSED')
  refused(f, followup(id(77)), 'TRANSITION_REFUSED')
  refused(f, followup(id(12), { recordedByMembershipId: M1, recordedByUserId: U1 }), 'TARGET_NOT_ELIGIBLE')
  refused(f, followup(id(12), { recordedByMembershipId: R, recordedByUserId: UR }), 'TARGET_NOT_ELIGIBLE')
  refused(f, followup(id(12), { recordedByUserId: UR }), 'TARGET_NOT_ELIGIBLE')
  refused(f, ret(id(11)), 'TRANSITION_REFUSED')
  // After a follow-up: an exact duplicate follow-up, a return of another escalation, and a return by the escalator,
  // the target (membership or user) or the acknowledger.
  const one = withFollowup()
  refused(one, followup(id(12)), 'TRANSITION_REFUSED')
  refused(one, ret(id(77)), 'TRANSITION_REFUSED')
  refused(one, ret(id(12)), 'TRANSITION_REFUSED')
  refused(one, ret(id(11), { recordedByMembershipId: M1, recordedByUserId: U1 }), 'NOT_INDEPENDENT')
  refused(one, ret(id(11), { recordedByUserId: U1 }), 'NOT_INDEPENDENT')
  refused(one, ret(id(11), { recordedByMembershipId: T, recordedByUserId: UT }), 'NOT_INDEPENDENT')
  refused(one, ret(id(11), { recordedByUserId: UT }), 'NOT_INDEPENDENT')
  refused(one, ret(id(11), { recordedByMembershipId: T }), 'NOT_INDEPENDENT')
})

test('the A8.7 gate (D1): nothing is written while a decision is pending or once resolved (T032–T034, T087)', () => {
  for (const code of escalationEventCodes) {
    assert.match(upstreamRefusal(code, 'RESOLVED_INTERNAL') ?? '', /RESOLVED_INTERNAL/)
    assert.match(upstreamRefusal(code, 'AWAITING_RESOLUTION_DECISION') ?? '', /awaits a decision/)
    assert.equal(upstreamRefusal(code, 'NO_RESOLUTION_REQUEST'), null)
    assert.equal(upstreamRefusal(code, 'RETURNED_FOR_REWORK'), null)
  }
  assert.match(upstreamRefusal('ESCALATE_FOR_REVIEW', 'RESOLVED_INTERNAL') ?? '', /never escalated/)
})

test('event shapes are exact (T012–T015, T018–T020, T067)', () => {
  for (const bad of [
    escalate({ reasonCode: 'BECAUSE' }), escalate({ reasonCode: null }), escalate({ targetMemberId: null }), escalate({ targetMemberId: 'x' }), escalate({ escalationEventId: id(5) }),
    escalate({ followupCode: 'SOURCE_RECHECK_RECORDED' }), escalate({ sourceEventKind: 'WORK_REPORT' }), escalate({ returnReasonCode: 'FOLLOWUP_RECORDED' }), escalate({ recordedByMembershipId: 'x' }),
    escalate({ recordedByUserId: '' }), escalate({ eventCode: 'CLOSE_EXCEPTION' }), escalate({ eventCode: 'ESCALATE' }),
  ])
    refused(NO_ESCALATION, bad, 'SHAPE')
  const a = awaiting()
  for (const bad of [ack('nope'), ack(id(11), { reasonCode: 'NEEDS_SUPERVISOR_REVIEW' }), ack(id(11), { targetMemberId: T }), ack(id(11), { acknowledgementEventId: id(12) })]) refused(a, bad, 'SHAPE')
  const f = active()
  for (const bad of [
    followup(id(12), { followupCode: 'DONE' }), followup(id(12), { followupCode: null }), followup(id(12), { sourceEventId: null }), followup(id(12), { sourceEventKind: null }),
    followup(id(12), { sourceEventKind: 'TRIAGE_EVENT' }), followup(id(12), { sourceEventKind: 'RESOLUTION_EVENT' }), followup(id(12), { escalationEventId: id(11) }), followup('x'),
  ])
    refused(f, bad, 'SHAPE')
  const one = withFollowup()
  for (const bad of [ret(id(11), { returnReasonCode: null }), ret(id(11), { returnReasonCode: 'CLOSED' }), ret(id(11), { followupCode: 'SOURCE_RECHECK_RECORDED' }), ret(id(11), { acknowledgementEventId: id(12) })])
    refused(one, bad, 'SHAPE')
})

const facts = (n: number, event: EscalationEventShape, o: Partial<EscalationEventFacts> = {}): EscalationEventFacts => ({
  ...event, id: id(100 + n), ...parent, contractVersion: 'A8-ESCALATION-1', sequence: n, ...o,
})

test('a whole stored history derives deterministically or is refused entirely (T091–T097)', () => {
  const history = [facts(1, escalate()), facts(2, ack(id(101))), facts(3, followup(id(102))), facts(4, ret(id(101)))]
  const first = JSON.stringify(deriveEscalation(parent, history))
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify(deriveEscalation(parent, history)), first)
  const derived = deriveEscalation(parent, history)
  assert.ok(derived.ok)
  assert.equal(derived.value.state, 'RETURNED_TO_OWNER')
  assert.deepEqual(deriveEscalation(parent, []), { ok: true, value: NO_ESCALATION })
  for (const broken of [
    [facts(2, escalate())],
    [facts(1, escalate()), facts(3, ack(id(101)))],
    [facts(1, escalate()), facts(1, ack(id(101)))],
    [facts(1, escalate(), { contractVersion: 'A8-ESCALATION-0' })],
    [facts(1, escalate(), { claimId: id(9) })],
    [facts(1, escalate(), { organizationId: id(9) })],
    [facts(1, escalate(), { exceptionIntakeId: id(9) })],
    [facts(1, escalate(), { id: 'x' })],
    [facts(1, escalate({ reasonCode: 'BECAUSE' }))],
    [facts(1, escalate()), facts(2, ack(id(101), { recordedByMembershipId: R, recordedByUserId: UR }))],
    [facts(1, escalate()), facts(2, ack(id(101))), facts(3, ret(id(101)))],
    [...history, facts(5, followup(id(102), { followupCode: 'INTERNAL_POLICY_REVIEWED' }))],
    [facts(1, escalate()), facts(2, escalate())],
  ] as EscalationEventFacts[][])
    assert.equal(deriveEscalation(parent, broken).ok, false, JSON.stringify(broken).slice(0, 160))
})

test('an unknown outcome is reconciled against the committed history only (T090)', () => {
  const attempted = { ...escalate(), sequence: 1 }
  assert.deepEqual(reconcileAttempt([], attempted), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([{ ...escalate(), id: id(61), sequence: 1 }], attempted), { outcome: 'RECORDED', escalationEventId: id(61) })
  assert.deepEqual(reconcileAttempt([{ ...escalate({ targetMemberId: R }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...escalate({ recordedByUserId: UR }), id: id(61), sequence: 1 }], attempted), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt([{ ...escalate(), id: id(61), sequence: 2 }], attempted), { outcome: 'NOT_RECORDED' })
})
