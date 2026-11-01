import {
  type AttemptedTriageEvent,
  type ReconciledOutcome,
  TRIAGE_CONTRACT_VERSION,
  returnReasonCodes,
  triageCategoryCodes,
  triagePriorityCodes,
  type DerivationResult,
  type DispositionState,
  type TransitionResult,
  type TriageCategoryCode,
  type TriageEventFacts,
  type TriageEventShape,
  type TriageParent,
  type TriagePriorityCode,
} from './exception-triage.types.ts'

// A8.2 §3 — the one pure, deterministic triage reducer. It reads an event's controlled content and the disposition
// before it, and answers the disposition after it or a refusal. It never reads a clock, locale, database or network,
// never orders by time or identifier, and never repairs: an event of the wrong shape, an illegal transition, a gap,
// a reused or out-of-order sequence, another intake's or tenant's event or an unknown contract is a refusal.
//
//   UNTRIAGED + TRIAGE_CLASSIFY(category, priority)            -> TRIAGED, no assignee
//   TRIAGED   + TRIAGE_CLASSIFY(category, priority) if changed -> TRIAGED (an identical repeat is refused)
//   TRIAGED   + ASSIGN_OWNER(member)                            -> ASSIGNED to that member
//   ASSIGNED  + REASSIGN_OWNER(another member)                  -> ASSIGNED to the new member
//   ASSIGNED  + RETURN_TO_TRIAGE(reason)                        -> TRIAGED, no assignee (category and priority kept)
//   any other pair                                              -> refused

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isCategory = (value: unknown): value is TriageCategoryCode => typeof value === 'string' && (triageCategoryCodes as readonly string[]).includes(value)
const isPriority = (value: unknown): value is TriagePriorityCode => typeof value === 'string' && (triagePriorityCodes as readonly string[]).includes(value)
const isReason = (value: unknown) => typeof value === 'string' && (returnReasonCodes as readonly string[]).includes(value)

export const UNTRIAGED: DispositionState = { dispositionCode: 'UNTRIAGED', categoryCode: null, priorityCode: null, assignedMemberId: null, lastSequence: 0 }

// The exact shape of each event: its own attributes present and controlled, every other attribute null.
function shapeRefusal(event: TriageEventShape): string | null {
  const { eventCode, categoryCode, priorityCode, assignedMemberId, reasonCode } = event
  if (eventCode === 'TRIAGE_CLASSIFY')
    return isCategory(categoryCode) && isPriority(priorityCode) && assignedMemberId === null && reasonCode === null ? null : 'a classification carries exactly a controlled category and priority'
  if (eventCode === 'ASSIGN_OWNER' || eventCode === 'REASSIGN_OWNER')
    return typeof assignedMemberId === 'string' && uuidShape.test(assignedMemberId) && categoryCode === null && priorityCode === null && reasonCode === null ? null : 'an assignment carries exactly one member'
  if (eventCode === 'RETURN_TO_TRIAGE')
    return isReason(reasonCode) && categoryCode === null && priorityCode === null && assignedMemberId === null ? null : 'a return carries exactly a controlled reason'
  return 'the event code is not a controlled triage event'
}

export function applyTriageEvent(state: DispositionState, event: TriageEventShape): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return { ok: false, detail: shape }
  const sequence = state.lastSequence + 1
  const { dispositionCode } = state
  switch (event.eventCode) {
    case 'TRIAGE_CLASSIFY':
      if (dispositionCode === 'ASSIGNED') return { ok: false, detail: 'an assigned exception is not reclassified; return it to triage first' }
      if (dispositionCode === 'TRIAGED' && event.categoryCode === state.categoryCode && event.priorityCode === state.priorityCode)
        return { ok: false, detail: 'the classification is unchanged; an identical repeat is not recorded' }
      return { ok: true, state: { dispositionCode: 'TRIAGED', categoryCode: event.categoryCode as TriageCategoryCode, priorityCode: event.priorityCode as TriagePriorityCode, assignedMemberId: null, lastSequence: sequence } }
    case 'ASSIGN_OWNER':
      if (dispositionCode !== 'TRIAGED') return { ok: false, detail: dispositionCode === 'ASSIGNED' ? 'the exception is already assigned; reassign it instead' : 'an untriaged exception is classified before it is assigned' }
      return { ok: true, state: { ...state, dispositionCode: 'ASSIGNED', assignedMemberId: event.assignedMemberId, lastSequence: sequence } }
    case 'REASSIGN_OWNER':
      if (dispositionCode !== 'ASSIGNED') return { ok: false, detail: 'only an assigned exception is reassigned' }
      if (event.assignedMemberId === state.assignedMemberId) return { ok: false, detail: 'a reassignment names a different member' }
      return { ok: true, state: { ...state, assignedMemberId: event.assignedMemberId, lastSequence: sequence } }
    case 'RETURN_TO_TRIAGE':
      if (dispositionCode !== 'ASSIGNED') return { ok: false, detail: 'only an assigned exception is returned to triage' }
      return { ok: true, state: { ...state, dispositionCode: 'TRIAGED', assignedMemberId: null, lastSequence: sequence } }
    default:
      return { ok: false, detail: 'the event code is not a controlled triage event' }
  }
}

// §6 — the disposition of one intake from its stored events, in the order the store returned them. Every event must
// belong to exactly this intake, organization and Claim, under this contract, numbered exactly 1..N in that order,
// and each must be a legal transition; anything else refuses the whole history (never a partial or guessed state).
export function deriveTriageDisposition(parent: TriageParent, events: readonly TriageEventFacts[]): DerivationResult {
  let state = UNTRIAGED
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'a triage event belongs to another intake, organization or claim' }
    if (event.contractVersion !== TRIAGE_CONTRACT_VERSION) return { ok: false, detail: 'a triage event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the triage events are not numbered exactly 1..N' }
    const next = applyTriageEvent(state, event)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal transition: ${next.detail}` }
    state = next.state
  }
  return { ok: true, value: state }
}

// D12 — an attempt whose commit outcome is unknown, judged against the committed history only: RECORDED when the event
// at the attempted number is exactly this one (actor and every controlled field), OTHER_EVENT when another event holds
// that number, NOT_RECORDED when none does. Never a guess from a time or an id, and never a reason to write again.
export function reconcileAttempt(committed: readonly (TriageEventShape & { id: string; sequence: number; recordedByUserId: string })[], attempted: AttemptedTriageEvent): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const exact =
    atNumber.length === 1 && event.eventCode === attempted.eventCode && event.categoryCode === attempted.categoryCode && event.priorityCode === attempted.priorityCode &&
    event.assignedMemberId === attempted.assignedMemberId && event.reasonCode === attempted.reasonCode && event.recordedByUserId === attempted.recordedByUserId
  return exact ? { outcome: 'RECORDED', triageEventId: event.id } : { outcome: 'OTHER_EVENT' }
}
