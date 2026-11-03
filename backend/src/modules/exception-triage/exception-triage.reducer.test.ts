import test from 'node:test'
import assert from 'node:assert/strict'
import { UNTRIAGED, applyTriageEvent, deriveTriageDisposition, reconcileAttempt } from './exception-triage.reducer.ts'
import { TRIAGE_CONTRACT_VERSION, type DispositionState, type TriageEventFacts, type TriageEventShape } from './exception-triage.types.ts'

// A8.2 — the transition table, exhaustively, and the read-side refusals. Synthetic values only.

const M1 = '00000000-0000-4000-8000-0000000000e1'
const M2 = '00000000-0000-4000-8000-0000000000e2'
const parent = { exceptionIntakeId: '00000000-0000-4000-8000-0000000000a1', organizationId: '00000000-0000-4000-8000-0000000000b1', claimId: '00000000-0000-4000-8000-0000000000c1' }

const classify = (categoryCode = 'PROVENANCE_INTEGRITY', priorityCode = 'ELEVATED'): TriageEventShape => ({ eventCode: 'TRIAGE_CLASSIFY', categoryCode, priorityCode, assignedMemberId: null, reasonCode: null })
const assign = (member = M1): TriageEventShape => ({ eventCode: 'ASSIGN_OWNER', categoryCode: null, priorityCode: null, assignedMemberId: member, reasonCode: null })
const reassign = (member = M2): TriageEventShape => ({ eventCode: 'REASSIGN_OWNER', categoryCode: null, priorityCode: null, assignedMemberId: member, reasonCode: null })
const giveBack = (reasonCode = 'ASSIGNEE_UNAVAILABLE'): TriageEventShape => ({ eventCode: 'RETURN_TO_TRIAGE', categoryCode: null, priorityCode: null, assignedMemberId: null, reasonCode })

const after = (state: DispositionState, event: TriageEventShape) => {
  const next = applyTriageEvent(state, event)
  assert.ok(next.ok, JSON.stringify(next))
  return next.state
}
const TRIAGED = after(UNTRIAGED, classify())
const ASSIGNED = after(TRIAGED, assign())
const facts = (events: TriageEventShape[]): TriageEventFacts[] => events.map((event, index) => ({ ...parent, contractVersion: TRIAGE_CONTRACT_VERSION, sequence: index + 1, ...event }))

test('every legal transition gives exactly the documented next disposition', () => {
  assert.deepEqual(TRIAGED, { dispositionCode: 'TRIAGED', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'ELEVATED', assignedMemberId: null, lastSequence: 1 })
  assert.deepEqual(ASSIGNED, { ...TRIAGED, dispositionCode: 'ASSIGNED', assignedMemberId: M1, lastSequence: 2 })
  assert.deepEqual(after(ASSIGNED, reassign()), { ...ASSIGNED, assignedMemberId: M2, lastSequence: 3 })
  assert.deepEqual(after(ASSIGNED, giveBack()), { ...TRIAGED, lastSequence: 3 })
  assert.deepEqual(after(TRIAGED, classify('HUMAN_REVIEW', 'ELEVATED')), { ...TRIAGED, categoryCode: 'HUMAN_REVIEW', lastSequence: 2 })
  assert.deepEqual(after(TRIAGED, classify('PROVENANCE_INTEGRITY', 'URGENT')), { ...TRIAGED, priorityCode: 'URGENT', lastSequence: 2 })
})

test('every other state/event pair is refused', () => {
  const refused: [DispositionState, TriageEventShape][] = [
    [UNTRIAGED, assign()], [UNTRIAGED, reassign()], [UNTRIAGED, giveBack()],
    [TRIAGED, reassign()], [TRIAGED, giveBack()], [TRIAGED, classify()],
    [ASSIGNED, classify('HUMAN_REVIEW', 'URGENT')], [ASSIGNED, assign(M2)], [ASSIGNED, reassign(M1)],
  ]
  for (const [state, event] of refused) assert.equal(applyTriageEvent(state, event).ok, false, `${state.dispositionCode} + ${event.eventCode}`)
})

test('an event of the wrong shape or an unknown code is refused from every state', () => {
  for (const state of [UNTRIAGED, TRIAGED, ASSIGNED]) {
    for (const event of [
      { ...classify(), assignedMemberId: M1 }, { ...classify(), categoryCode: 'PAID' }, { ...classify(), priorityCode: null }, { ...classify(), reasonCode: 'ASSIGNEE_UNAVAILABLE' },
      { ...assign(), assignedMemberId: 'not-a-uuid' }, { ...assign(), categoryCode: 'HUMAN_REVIEW' }, { ...assign(), assignedMemberId: null },
      { ...giveBack(), reasonCode: 'RESOLVED' }, { ...giveBack(), assignedMemberId: M1 },
      { eventCode: 'RESOLVE', categoryCode: null, priorityCode: null, assignedMemberId: null, reasonCode: null },
      { eventCode: 'triage_classify', categoryCode: 'HUMAN_REVIEW', priorityCode: 'ROUTINE', assignedMemberId: null, reasonCode: null },
    ]) {
      assert.equal(applyTriageEvent(state, event).ok, false, `${state.dispositionCode}: ${JSON.stringify(event)}`)
    }
  }
})

test('the worked scenario derives ASSIGNED to M2, then TRIAGED with no assignee', () => {
  const assignedM2 = deriveTriageDisposition(parent, facts([classify(), assign(M1), reassign(M2)]))
  assert.deepEqual(assignedM2, { ok: true, value: { dispositionCode: 'ASSIGNED', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'ELEVATED', assignedMemberId: M2, lastSequence: 3 } })
  const returned = deriveTriageDisposition(parent, facts([classify(), assign(M1), reassign(M2), giveBack()]))
  assert.deepEqual(returned, { ok: true, value: { dispositionCode: 'TRIAGED', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'ELEVATED', assignedMemberId: null, lastSequence: 4 } })
  assert.deepEqual(deriveTriageDisposition(parent, []), { ok: true, value: UNTRIAGED })
  // The same history always gives the same disposition.
  const histories = Array.from({ length: 20 }, () => JSON.stringify(deriveTriageDisposition(parent, facts([classify(), assign(M1), reassign(M2), giveBack()]))))
  assert.equal(new Set(histories).size, 1)
})

test('a gap, reused or out-of-order sequence, foreign event, unknown contract or illegal stored transition refuses the history', () => {
  const good = facts([classify(), assign(M1), reassign(M2)])
  const variants: TriageEventFacts[][] = [
    [good[0], { ...good[1], sequence: 3 }],
    [good[0], { ...good[1], sequence: 1 }],
    [{ ...good[0], sequence: 2 }, { ...good[1], sequence: 1 }],
    [{ ...good[0], sequence: 0 }],
    [good[0], { ...good[1], exceptionIntakeId: '00000000-0000-4000-8000-0000000000a2' }],
    [good[0], { ...good[1], organizationId: '00000000-0000-4000-8000-0000000000b2' }],
    [good[0], { ...good[1], claimId: '00000000-0000-4000-8000-0000000000c2' }],
    [{ ...good[0], contractVersion: 'A8-EXCEPTION-TRIAGE-2' }],
    facts([assign(M1)]),
    facts([classify(), giveBack()]),
    facts([classify(), assign(M1), assign(M2)]),
  ]
  for (const events of variants) assert.equal(deriveTriageDisposition(parent, events).ok, false, JSON.stringify(events.map((e) => [e.sequence, e.eventCode])))
})

test('an uncertain attempt is reconciled only against the committed event at its own number', () => {
  const ACTOR = '00000000-0000-4000-8000-0000000000d1'
  const OTHER = '00000000-0000-4000-8000-0000000000d2'
  const committed = [classify(), assign()].map((event, index) => ({ ...event, id: `00000000-0000-4000-8000-00000000000${index + 1}`, sequence: index + 1, recordedByUserId: ACTOR }))
  const attempt = { ...assign(), sequence: 2, recordedByUserId: ACTOR }
  assert.deepEqual(reconcileAttempt(committed, attempt), { outcome: 'RECORDED', triageEventId: '00000000-0000-4000-8000-000000000002' })
  // Another actor, another member or another code at that number is another event; nothing of the attempt is recorded.
  assert.deepEqual(reconcileAttempt(committed, { ...attempt, recordedByUserId: OTHER }), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt(committed, { ...assign(M2), sequence: 2, recordedByUserId: ACTOR }), { outcome: 'OTHER_EVENT' })
  assert.deepEqual(reconcileAttempt(committed, { ...giveBack(), sequence: 2, recordedByUserId: ACTOR }), { outcome: 'OTHER_EVENT' })
  // No event at the attempted number: nothing was recorded, whatever the earlier events are.
  assert.deepEqual(reconcileAttempt(committed, { ...reassign(), sequence: 3, recordedByUserId: ACTOR }), { outcome: 'NOT_RECORDED' })
  assert.deepEqual(reconcileAttempt([], { ...classify(), sequence: 1, recordedByUserId: ACTOR }), { outcome: 'NOT_RECORDED' })
})
