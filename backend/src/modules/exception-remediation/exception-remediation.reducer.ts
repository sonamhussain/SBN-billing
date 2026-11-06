import {
  type ActionCode,
  type AttemptedRemediationEvent,
  type DecisionCode,
  type DerivationResult,
  type ProposalRecord,
  REMEDIATION_CONTRACT_VERSION,
  type RationaleCode,
  type ReconciledOutcome,
  type RemediationDerived,
  type RemediationEventFacts,
  type RemediationEventShape,
  type RemediationParent,
  type ReviewReasonCode,
  type TransitionResult,
  actionCodes,
  decisionCodes,
  rationaleCodes,
  reviewReasonCodes,
} from './exception-remediation.types.ts'

// A8.5 §3/§4 — the one pure, deterministic remediation reducer. It reads an event's controlled content, its actor and
// the remediation before it, and answers the remediation after it or a refusal. It never reads a clock, locale,
// database or network, never orders by time or identifier, and never repairs: an event of the wrong shape, a review
// of anything but the outstanding proposal, a self-review, a gap, a reused or out-of-order sequence, another intake's
// or tenant's event or an unknown contract is a refusal.
//
//   NO_PROPOSAL           + PROPOSE_ACTION                -> AWAITING_REVIEW
//   RETURNED_FOR_REVISION + PROPOSE_ACTION                -> AWAITING_REVIEW (not an exact repeat of the returned one)
//   AWAITING_REVIEW       + REVIEW_ACTION(APPROVE_PROPOSAL) -> APPROVED_FOR_PLANNING (terminal)
//   AWAITING_REVIEW       + REVIEW_ACTION(RETURN_PROPOSAL)  -> RETURNED_FOR_REVISION
// Anything else is refused: a second proposal while one awaits review, a review with nothing outstanding or of another
// proposal, a review by the proposal's own membership or user, and any event after an approval.
// Whether the proposer is the current A8.2 assignee, the reviewer holds the review permission now, and the finding is
// an A8.3 RECORD_FINDING of this intake are the service's and the database's to hold; the reducer judges the history.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidShape.test(value)
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export const NO_PROPOSAL: RemediationDerived = { state: 'NO_PROPOSAL', proposals: [], decisions: [], pendingProposal: null, lastSequence: 0 }

// The exact shape of each event: its own attributes present and controlled, every other attribute null. A return
// carries a reason; an approval carries none.
function shapeRefusal(event: RemediationEventShape): string | null {
  const { eventCode, actionCode, findingEventId, rationaleCode, proposalEventId, decisionCode, reviewReasonCode } = event
  if (!isUuid(event.recordedByMembershipId) || !isUuid(event.recordedByUserId)) return 'an event names its acting membership and user'
  if (eventCode === 'PROPOSE_ACTION')
    return oneOf(actionCodes, actionCode) && isUuid(findingEventId) && oneOf(rationaleCodes, rationaleCode) && proposalEventId === null && decisionCode === null && reviewReasonCode === null
      ? null
      : 'a proposal carries exactly one controlled action, one A8.3 finding event and one controlled rationale'
  if (eventCode === 'REVIEW_ACTION') {
    const reasonOk = decisionCode === 'RETURN_PROPOSAL' ? oneOf(reviewReasonCodes, reviewReasonCode) : decisionCode === 'APPROVE_PROPOSAL' && reviewReasonCode === null
    return isUuid(proposalEventId) && oneOf(decisionCodes, decisionCode) && reasonOk && actionCode === null && findingEventId === null && rationaleCode === null
      ? null
      : 'a review carries exactly one proposal event, a controlled decision and, for a return only, a controlled reason'
  }
  return 'the event code is not a controlled remediation event'
}

// The next event, given the remediation before it. `id` is the event's own stored id (null for an event not yet
// written): a later review names a proposal by it.
export function applyRemediationEvent(before: RemediationDerived, event: RemediationEventShape, id: string | null = null): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return { ok: false, detail: shape }
  const sequence = before.lastSequence + 1
  if (before.state === 'APPROVED_FOR_PLANNING') return { ok: false, detail: 'the proposal of this exception was approved for planning; no further remediation event is recorded in v1' }
  if (event.eventCode === 'PROPOSE_ACTION') {
    if (before.state === 'AWAITING_REVIEW') return { ok: false, detail: 'a proposal already awaits review; a second outstanding proposal is not recorded' }
    const returned = before.proposals[before.proposals.length - 1]
    if (before.state === 'RETURNED_FOR_REVISION' && returned && returned.actionCode === event.actionCode && returned.findingEventId === event.findingEventId && returned.rationaleCode === event.rationaleCode)
      return { ok: false, detail: 'the proposal repeats the returned proposal unchanged; a fresh proposal must differ from it' }
    const proposal: ProposalRecord = {
      remediationEventId: id ?? '',
      sequence,
      actionCode: event.actionCode as ActionCode,
      findingEventId: event.findingEventId as string,
      rationaleCode: event.rationaleCode as RationaleCode,
      proposedByMembershipId: event.recordedByMembershipId,
      proposedByUserId: event.recordedByUserId,
    }
    return { ok: true, derived: { state: 'AWAITING_REVIEW', proposals: [...before.proposals, proposal], decisions: before.decisions, pendingProposal: proposal, lastSequence: sequence } }
  }
  const pending = before.pendingProposal
  if (before.state !== 'AWAITING_REVIEW' || !pending) return { ok: false, detail: 'no proposal of this exception awaits review' }
  if (event.proposalEventId !== pending.remediationEventId) return { ok: false, detail: 'a review names exactly the proposal that awaits review' }
  if (event.recordedByMembershipId === pending.proposedByMembershipId || event.recordedByUserId === pending.proposedByUserId)
    return { ok: false, detail: "a proposal is never reviewed by its own author's membership or user" }
  const decision = {
    remediationEventId: id ?? '',
    sequence,
    proposalEventId: pending.remediationEventId,
    decisionCode: event.decisionCode as DecisionCode,
    reviewReasonCode: event.reviewReasonCode as ReviewReasonCode | null,
    reviewedByMembershipId: event.recordedByMembershipId,
    reviewedByUserId: event.recordedByUserId,
  }
  return {
    ok: true,
    derived: {
      state: decision.decisionCode === 'APPROVE_PROPOSAL' ? 'APPROVED_FOR_PLANNING' : 'RETURNED_FOR_REVISION',
      proposals: before.proposals,
      decisions: [...before.decisions, decision],
      pendingProposal: null,
      lastSequence: sequence,
    },
  }
}

// §5 — the remediation of one intake from its stored events, in the order the store returned them. Every event must
// belong to exactly this intake, organization and Claim, under this contract, numbered exactly 1..N in that order,
// and each must be a legal next step; anything else refuses the whole history (never a partial or guessed view).
export function deriveRemediation(parent: RemediationParent, events: readonly RemediationEventFacts[]): DerivationResult {
  let derived = NO_PROPOSAL
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'a remediation event belongs to another intake, organization or claim' }
    if (event.contractVersion !== REMEDIATION_CONTRACT_VERSION) return { ok: false, detail: 'a remediation event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the remediation events are not numbered exactly 1..N' }
    if (!isUuid(event.id)) return { ok: false, detail: 'a remediation event has no valid identity' }
    const next = applyRemediationEvent(derived, event, event.id)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal step: ${next.detail}` }
    derived = next.derived
  }
  return { ok: true, value: derived }
}

// An attempt whose commit outcome is unknown, judged against the committed history only: RECORDED when the event at
// the attempted number is exactly this one (membership, actor and every controlled field), OTHER_EVENT when another
// event holds that number, NOT_RECORDED when none does. Never a guess from a time or an id, and never a reason to
// write again.
export function reconcileAttempt(committed: readonly (RemediationEventShape & { id: string; sequence: number })[], attempted: AttemptedRemediationEvent): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const fields: (keyof RemediationEventShape)[] = ['eventCode', 'actionCode', 'findingEventId', 'rationaleCode', 'proposalEventId', 'decisionCode', 'reviewReasonCode', 'recordedByMembershipId', 'recordedByUserId']
  const exact = atNumber.length === 1 && fields.every((field) => event[field] === attempted[field])
  return exact ? { outcome: 'RECORDED', remediationEventId: event.id } : { outcome: 'OTHER_EVENT' }
}
