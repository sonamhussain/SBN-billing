import {
  type AttemptedResolutionEvent,
  type DecisionCode,
  type DerivationResult,
  type PlanDispositionFacts,
  RESOLUTION_CONTRACT_VERSION,
  type ReconciledOutcome,
  type RequestReasonCode,
  type ResolutionDecisionRecord,
  type ResolutionDerived,
  type ResolutionEventFacts,
  type ResolutionEventShape,
  type ResolutionParent,
  type ResolutionRefusal,
  type ResolutionRequestRecord,
  type ReturnReasonCode,
  type TransitionResult,
  type VerifiedBasis,
  type WorkDispositionFacts,
  decisionCodes,
  requestReasonCodes,
  returnReasonCodes,
} from './exception-resolution.types.ts'

// A8.7 §3/§4 — the one pure, deterministic resolution reducer. It reads an event's controlled content, its actor, the
// intake's verified A8.6 work record and the resolution before it, and answers the resolution after it or a refusal. It
// never reads a clock, locale, database or network, never orders by time or identifier, and never repairs: an event of
// the wrong shape, a request without the exact verified basis, a decision of anything but the pending request, a
// self-decision, any event after a decision, a gap, a reused or out-of-order sequence, another intake's or tenant's
// event or an unknown contract is a refusal.
//
//   NO_RESOLUTION_REQUEST        + REQUEST_INTERNAL_RESOLUTION                -> AWAITING_RESOLUTION_DECISION
//   AWAITING_RESOLUTION_DECISION + DECIDE_INTERNAL_RESOLUTION(CONFIRM)        -> RESOLVED_INTERNAL   (terminal)
//   AWAITING_RESOLUTION_DECISION + DECIDE_INTERNAL_RESOLUTION(RETURN, reason) -> RETURNED_FOR_REWORK (terminal in v1)
// Anything else is refused: a request without the intake's verified A8.6 record or citing another one, a second request
// while one awaits a decision, a decision with nothing pending or of another request, a decision by the requester's own
// membership or user (D5), and any event after RESOLVED_INTERNAL or RETURNED_FOR_REWORK (auditor correction 1: rework
// after a return is a separately approved future version). Whether the requester is the current A8.2 assignee and the
// decider holds the decide permission now are the service's and the database's to hold; the reducer judges the history.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidShape.test(value)
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const refuse = (refusal: ResolutionRefusal, detail: string): TransitionResult => ({ ok: false, refusal, detail })

export const NO_RESOLUTION_REQUEST: ResolutionDerived = { state: 'NO_RESOLUTION_REQUEST', request: null, decision: null, lastSequence: 0 }

const TERMINAL: readonly string[] = ['RESOLVED_INTERNAL', 'RETURNED_FOR_REWORK']

// D4 — the intake's verified A8.6 work record as A8.6 recorded it, or null unless its accepted disposition is
// VERIFIED_INTERNAL_WORK with an EVIDENCE_SUPPORTED verification of its report, AND that work sits on exactly the plan
// the A8.5 owner reports as APPROVED_FOR_PLANNING. A NOT_VERIFIED, pending or absent work record, or work on any other
// plan, is never a basis. (Same Claim, intake and organization: both owners are read for this intake on one client.)
export function verifiedBasisOf(work: WorkDispositionFacts, plan: PlanDispositionFacts): VerifiedBasis | null {
  const { state, approvedProposalEventId, verification } = work
  if (state !== 'VERIFIED_INTERNAL_WORK' || !verification || verification.verificationCode !== 'EVIDENCE_SUPPORTED') return null
  if (!isUuid(verification.workEventId) || !isUuid(verification.workReportEventId) || !isUuid(approvedProposalEventId)) return null
  if (plan.state !== 'APPROVED_FOR_PLANNING' || plan.approvedProposalEventId !== approvedProposalEventId) return null
  return { verificationEventId: verification.workEventId, workReportEventId: verification.workReportEventId, approvedProposalEventId }
}

// The exact shape of each event: its own attributes present and controlled, every other attribute null. A request
// carries its verification and reason; a decision carries its request, its code and, for a return only, a reason.
function shapeRefusal(event: ResolutionEventShape): string | null {
  const { eventCode, verificationEventId, requestEventId, reasonCode, decisionCode, returnReasonCode } = event
  if (!isUuid(event.recordedByMembershipId) || !isUuid(event.recordedByUserId)) return 'an event names its acting membership and user'
  if (eventCode === 'REQUEST_INTERNAL_RESOLUTION')
    return isUuid(verificationEventId) && oneOf(requestReasonCodes, reasonCode) && requestEventId === null && decisionCode === null && returnReasonCode === null
      ? null
      : 'a resolution request carries exactly one verified A8.6 work record and a controlled reason'
  if (eventCode === 'DECIDE_INTERNAL_RESOLUTION') {
    const reasonOk = decisionCode === 'RETURN_FOR_REWORK' ? oneOf(returnReasonCodes, returnReasonCode) : decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' && returnReasonCode === null
    return isUuid(requestEventId) && oneOf(decisionCodes, decisionCode) && reasonOk && verificationEventId === null && reasonCode === null
      ? null
      : 'a resolution decision carries exactly one request, a controlled decision code and, for a return only, a controlled reason'
  }
  return 'the event code is not a controlled resolution event'
}

// The next event, given the resolution before it and the intake's verified A8.6 record (null when none exists). `id`
// is the event's own stored id (null for an event not yet written): a later decision names a request by it.
export function applyResolutionEvent(before: ResolutionDerived, basis: VerifiedBasis | null, event: ResolutionEventShape, id: string | null = null): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return refuse('SHAPE', shape)
  const sequence = before.lastSequence + 1
  if (TERMINAL.includes(before.state))
    return refuse('TRANSITION_REFUSED', `the resolution is ${before.state}, which is terminal in v1; no further resolution event is recorded`)
  if (event.eventCode === 'REQUEST_INTERNAL_RESOLUTION') {
    if (before.state === 'AWAITING_RESOLUTION_DECISION') return refuse('TRANSITION_REFUSED', 'a resolution request already awaits a decision; a second request is not recorded')
    if (!basis) return refuse('BASIS_NOT_VERIFIED', 'the exception has no independently verified A8.6 work record; no resolution is requested against it')
    if (event.verificationEventId !== basis.verificationEventId) return refuse('BASIS_NOT_VERIFIED', "a request names exactly the exception's verified A8.6 work record")
    const request: ResolutionRequestRecord = {
      resolutionEventId: id ?? '',
      sequence,
      verificationEventId: basis.verificationEventId,
      reasonCode: event.reasonCode as RequestReasonCode,
      requestedByMembershipId: event.recordedByMembershipId,
      requestedByUserId: event.recordedByUserId,
    }
    return {
      ok: true,
      derived: { state: 'AWAITING_RESOLUTION_DECISION', request, decision: null, lastSequence: sequence },
    }
  }
  const request = before.request
  if (before.state !== 'AWAITING_RESOLUTION_DECISION' || !request) return refuse('TRANSITION_REFUSED', 'no resolution request of this exception awaits a decision')
  if (event.requestEventId !== request.resolutionEventId) return refuse('TRANSITION_REFUSED', 'a decision names exactly the request that awaits a decision')
  if (event.recordedByMembershipId === request.requestedByMembershipId || event.recordedByUserId === request.requestedByUserId)
    return refuse('REVIEWER_NOT_INDEPENDENT', "a resolution request is never decided by its own requester's membership or user")
  // D6 — the request's verified basis must still be the intake's verified A8.6 record when it is decided.
  if (!basis || basis.verificationEventId !== request.verificationEventId)
    return refuse('BASIS_NOT_VERIFIED', "the request's verified A8.6 work record is no longer the exception's verified record")
  const decision: ResolutionDecisionRecord = {
    resolutionEventId: id ?? '',
    sequence,
    requestEventId: request.resolutionEventId,
    decisionCode: event.decisionCode as DecisionCode,
    returnReasonCode: event.returnReasonCode as ReturnReasonCode | null,
    decidedByMembershipId: event.recordedByMembershipId,
    decidedByUserId: event.recordedByUserId,
  }
  return {
    ok: true,
    derived: {
      state: decision.decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' ? 'RESOLVED_INTERNAL' : 'RETURNED_FOR_REWORK',
      request,
      decision,
      lastSequence: sequence,
    },
  }
}

// §6 — the resolution of one intake from its stored events, in the order the store returned them, against the intake's
// verified A8.6 record. Every event must belong to exactly this intake, organization and Claim, under this contract,
// numbered exactly 1..N in that order, and each must be a legal next step; anything else refuses the whole history
// (never a partial or guessed view). A stored request without a verified basis is itself inconsistent.
export function deriveResolution(parent: ResolutionParent, basis: VerifiedBasis | null, events: readonly ResolutionEventFacts[]): DerivationResult {
  let derived = NO_RESOLUTION_REQUEST
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'a resolution event belongs to another intake, organization or claim' }
    if (event.contractVersion !== RESOLUTION_CONTRACT_VERSION) return { ok: false, detail: 'a resolution event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the resolution events are not numbered exactly 1..N' }
    if (!isUuid(event.id)) return { ok: false, detail: 'a resolution event has no valid identity' }
    const next = applyResolutionEvent(derived, basis, event, event.id)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal step: ${next.detail}` }
    derived = next.derived
  }
  return { ok: true, value: derived }
}

// An attempt whose commit outcome is unknown, judged against the committed history only: RECORDED when the event at
// the attempted number is exactly this one (membership, actor and every controlled field), OTHER_EVENT when another
// event holds that number, NOT_RECORDED when none does. Never a guess from a time or an id, and never a reason to
// write again.
export function reconcileAttempt(committed: readonly (ResolutionEventShape & { id: string; sequence: number })[], attempted: AttemptedResolutionEvent): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const fields: (keyof ResolutionEventShape)[] = [
    'eventCode',
    'verificationEventId',
    'requestEventId',
    'reasonCode',
    'decisionCode',
    'returnReasonCode',
    'recordedByMembershipId',
    'recordedByUserId',
  ]
  const exact = atNumber.length === 1 && fields.every((field) => event[field] === attempted[field])
  return exact ? { outcome: 'RECORDED', resolutionEventId: event.id } : { outcome: 'OTHER_EVENT' }
}
