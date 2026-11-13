import {
  type AttemptedEscalationEvent,
  type DerivationResult,
  ESCALATION_CONTRACT_VERSION,
  type EscalationDerived,
  type EscalationEventFacts,
  type EscalationEventShape,
  type EscalationParent,
  type EscalationReasonCode,
  type EscalationRefusal,
  type FollowupCode,
  type ReconciledOutcome,
  type ReturnReasonCode,
  type SourceEventKind,
  type TransitionResult,
  type UpstreamResolutionState,
  escalationReasonCodes,
  followupCodes,
  returnReasonCodes,
  sourceEventKinds,
} from './exception-escalation.types.ts'

// A8.8 §3 — the one pure, deterministic escalation reducer. It reads an event's controlled content, its actor and the
// escalation before it, and answers the escalation after it or a refusal. It never reads a clock, locale, database or
// network, never orders by time or identifier, and never repairs: an event of the wrong shape, an acknowledgement or
// follow-up by anyone but the nominated member, a return by anyone not independent of the escalator and the target, a
// step out of order, a duplicate follow-up, any event after the return, a gap, a reused or out-of-order sequence,
// another intake's or tenant's event or an unknown contract is a refusal.
//
//   NO_ESCALATION            + ESCALATE_FOR_REVIEW(reason, target)            -> AWAITING_ACKNOWLEDGEMENT
//   AWAITING_ACKNOWLEDGEMENT + ACKNOWLEDGE_ESCALATION(escalation) by target   -> FOLLOWUP_ACTIVE
//   FOLLOWUP_ACTIVE          + RECORD_FOLLOWUP(ack, code, source) by target   -> FOLLOWUP_ACTIVE (one more step)
//   FOLLOWUP_ACTIVE (>=1 follow-up) + RETURN_TO_OWNER(escalation, reason)     -> RETURNED_TO_OWNER (terminal in v1)
// Whether the escalator is the current A8.2 assignee, the target and the reviewer hold their permissions now, the
// reviewer is not the current assignee, the cited source is an exact A8.3/A8.6 record of the intake, and A8.7 permits
// the write, are the service's and the database's to hold at write time (`upstreamRefusal` below for A8.7); the
// reducer judges the history, which stays valid as recorded when the upstream later moves on.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidShape.test(value)
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const refuse = (refusal: EscalationRefusal, detail: string): TransitionResult => ({ ok: false, refusal, detail })

export const NO_ESCALATION: EscalationDerived = { state: 'NO_ESCALATION', escalation: null, acknowledgement: null, followups: [], returned: null, lastSequence: 0 }

// D1 — the A8.7 states under which no A8.8 event is written: a resolution decision is pending (one governed review
// at a time), or the exception is RESOLVED_INTERNAL (never escalated, never overridden). From NO_RESOLUTION_REQUEST
// and RETURNED_FOR_REWORK every legal escalation step may be written.
export function upstreamRefusal(eventCode: string, resolution: UpstreamResolutionState): string | null {
  if (resolution === 'RESOLVED_INTERNAL')
    return eventCode === 'ESCALATE_FOR_REVIEW'
      ? 'the exception is RESOLVED_INTERNAL under A8.7; a resolved exception is never escalated'
      : 'the exception is RESOLVED_INTERNAL under A8.7; no further escalation event is recorded'
  if (resolution === 'AWAITING_RESOLUTION_DECISION')
    return eventCode === 'ESCALATE_FOR_REVIEW'
      ? 'an A8.7 resolution request awaits a decision; the exception is not escalated while it is pending'
      : 'an A8.7 resolution request awaits a decision; the escalation does not move on while it is pending'
  return null
}

// The exact shape of each event: its own attributes present and controlled, every other attribute null.
function shapeRefusal(event: EscalationEventShape): string | null {
  const { eventCode, reasonCode, targetMemberId, escalationEventId, acknowledgementEventId, followupCode, sourceEventId, sourceEventKind, returnReasonCode } = event
  if (!isUuid(event.recordedByMembershipId) || !isUuid(event.recordedByUserId)) return 'an event names its acting membership and user'
  const nullExcept = (own: readonly string[]) =>
    (
      [
        ['reasonCode', reasonCode],
        ['targetMemberId', targetMemberId],
        ['escalationEventId', escalationEventId],
        ['acknowledgementEventId', acknowledgementEventId],
        ['followupCode', followupCode],
        ['sourceEventId', sourceEventId],
        ['sourceEventKind', sourceEventKind],
        ['returnReasonCode', returnReasonCode],
      ] as const
    ).every(([key, value]) => own.includes(key) || value === null)
  if (eventCode === 'ESCALATE_FOR_REVIEW')
    return oneOf(escalationReasonCodes, reasonCode) && isUuid(targetMemberId) && nullExcept(['reasonCode', 'targetMemberId'])
      ? null
      : 'an escalation carries exactly a controlled reason and one nominated member'
  if (eventCode === 'ACKNOWLEDGE_ESCALATION')
    return isUuid(escalationEventId) && nullExcept(['escalationEventId']) ? null : 'an acknowledgement carries exactly the escalation it acknowledges'
  if (eventCode === 'RECORD_FOLLOWUP')
    return isUuid(acknowledgementEventId) && oneOf(followupCodes, followupCode) && isUuid(sourceEventId) && oneOf(sourceEventKinds, sourceEventKind) && nullExcept(['acknowledgementEventId', 'followupCode', 'sourceEventId', 'sourceEventKind'])
      ? null
      : 'a follow-up carries exactly its acknowledgement, a controlled follow-up code and one cited A8.3 or A8.6 record of a controlled kind'
  if (eventCode === 'RETURN_TO_OWNER')
    return isUuid(escalationEventId) && oneOf(returnReasonCodes, returnReasonCode) && nullExcept(['escalationEventId', 'returnReasonCode'])
      ? null
      : 'a return carries exactly the escalation it returns and a controlled return reason'
  return 'the event code is not a controlled escalation event'
}

// The next event, given the escalation before it. `id` is the event's own stored id (null for an event not yet
// written): a later event names the escalation or the acknowledgement by it.
export function applyEscalationEvent(before: EscalationDerived, event: EscalationEventShape, id: string | null = null): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return refuse('SHAPE', shape)
  const sequence = before.lastSequence + 1
  const own = id ?? ''
  if (before.state === 'RETURNED_TO_OWNER')
    return refuse('TRANSITION_REFUSED', 'the escalation is RETURNED_TO_OWNER, which is terminal in v1; no further escalation event is recorded')

  if (event.eventCode === 'ESCALATE_FOR_REVIEW') {
    if (before.state !== 'NO_ESCALATION') return refuse('TRANSITION_REFUSED', 'an escalation of this exception is already open; a second escalation is not recorded')
    if (event.targetMemberId === event.recordedByMembershipId) return refuse('NOT_INDEPENDENT', 'an escalation never nominates its own escalator')
    return {
      ok: true,
      derived: {
        ...NO_ESCALATION,
        state: 'AWAITING_ACKNOWLEDGEMENT',
        escalation: {
          escalationEventId: own,
          sequence,
          reasonCode: event.reasonCode as EscalationReasonCode,
          targetMemberId: event.targetMemberId as string,
          escalatedByMembershipId: event.recordedByMembershipId,
          escalatedByUserId: event.recordedByUserId,
        },
        lastSequence: sequence,
      },
    }
  }

  const escalation = before.escalation
  if (!escalation) return refuse('TRANSITION_REFUSED', 'no escalation of this exception is open')

  if (event.eventCode === 'ACKNOWLEDGE_ESCALATION') {
    if (before.state !== 'AWAITING_ACKNOWLEDGEMENT') return refuse('TRANSITION_REFUSED', 'the escalation is already acknowledged; it is acknowledged once')
    if (event.escalationEventId !== escalation.escalationEventId) return refuse('TRANSITION_REFUSED', 'an acknowledgement names exactly the open escalation')
    if (event.recordedByMembershipId === escalation.escalatedByMembershipId || event.recordedByUserId === escalation.escalatedByUserId)
      return refuse('NOT_INDEPENDENT', 'an escalation is never acknowledged by its own escalator')
    if (event.recordedByMembershipId !== escalation.targetMemberId) return refuse('TARGET_NOT_ELIGIBLE', 'only the nominated member acknowledges the escalation')
    return {
      ok: true,
      derived: {
        ...before,
        state: 'FOLLOWUP_ACTIVE',
        acknowledgement: { acknowledgementEventId: own, sequence, acknowledgedByMembershipId: event.recordedByMembershipId, acknowledgedByUserId: event.recordedByUserId },
        lastSequence: sequence,
      },
    }
  }

  const acknowledgement = before.acknowledgement
  if (event.eventCode === 'RECORD_FOLLOWUP') {
    if (before.state !== 'FOLLOWUP_ACTIVE' || !acknowledgement) return refuse('TRANSITION_REFUSED', 'a follow-up is recorded only after the nominated member acknowledges the escalation')
    if (event.acknowledgementEventId !== acknowledgement.acknowledgementEventId) return refuse('TRANSITION_REFUSED', "a follow-up names exactly the escalation's acknowledgement")
    if (event.recordedByMembershipId !== escalation.targetMemberId || event.recordedByUserId !== acknowledgement.acknowledgedByUserId)
      return refuse('TARGET_NOT_ELIGIBLE', 'only the nominated member who acknowledged the escalation records its follow-ups')
    if (before.followups.some((followup) => followup.followupCode === event.followupCode && followup.sourceEventId === event.sourceEventId))
      return refuse('TRANSITION_REFUSED', 'this follow-up (the same code citing the same record) is already recorded; a further follow-up is a distinct step')
    return {
      ok: true,
      derived: {
        ...before,
        followups: [
          ...before.followups,
          {
            followupEventId: own,
            sequence,
            followupCode: event.followupCode as FollowupCode,
            sourceEventId: event.sourceEventId as string,
            sourceEventKind: event.sourceEventKind as SourceEventKind,
            recordedByMembershipId: event.recordedByMembershipId,
            recordedByUserId: event.recordedByUserId,
          },
        ],
        lastSequence: sequence,
      },
    }
  }

  // RETURN_TO_OWNER
  if (before.state !== 'FOLLOWUP_ACTIVE' || !acknowledgement || before.followups.length === 0)
    return refuse('TRANSITION_REFUSED', 'an escalation is returned only after it is acknowledged and at least one follow-up is recorded')
  if (event.escalationEventId !== escalation.escalationEventId) return refuse('TRANSITION_REFUSED', 'a return names exactly the open escalation')
  const reviewerIs = (membershipId: string, userId: string) => event.recordedByMembershipId === membershipId || event.recordedByUserId === userId
  if (reviewerIs(escalation.escalatedByMembershipId, escalation.escalatedByUserId) || reviewerIs(acknowledgement.acknowledgedByMembershipId, acknowledgement.acknowledgedByUserId) || event.recordedByMembershipId === escalation.targetMemberId)
    return refuse('NOT_INDEPENDENT', 'an escalation is returned only by a member independent of its escalator and its nominated member')
  return {
    ok: true,
    derived: {
      ...before,
      state: 'RETURNED_TO_OWNER',
      returned: { returnEventId: own, sequence, returnReasonCode: event.returnReasonCode as ReturnReasonCode, returnedByMembershipId: event.recordedByMembershipId, returnedByUserId: event.recordedByUserId },
      lastSequence: sequence,
    },
  }
}

// §6 — the escalation of one intake from its stored events, in the order the store returned them. Every event must
// belong to exactly this intake, organization and Claim, under this contract, numbered exactly 1..N in that order, and
// each must be a legal next step; anything else refuses the whole history (never a partial or guessed view).
export function deriveEscalation(parent: EscalationParent, events: readonly EscalationEventFacts[]): DerivationResult {
  let derived = NO_ESCALATION
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'an escalation event belongs to another intake, organization or claim' }
    if (event.contractVersion !== ESCALATION_CONTRACT_VERSION) return { ok: false, detail: 'an escalation event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the escalation events are not numbered exactly 1..N' }
    if (!isUuid(event.id)) return { ok: false, detail: 'an escalation event has no valid identity' }
    const next = applyEscalationEvent(derived, event, event.id)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal step: ${next.detail}` }
    derived = next.derived
  }
  return { ok: true, value: derived }
}

// An attempt whose commit outcome is unknown, judged against the committed history only: RECORDED when the event at
// the attempted number is exactly this one (membership, actor and every controlled field), OTHER_EVENT when another
// event holds that number, NOT_RECORDED when none does. Never a guess from a time or an id, and never a reason to
// write again.
export function reconcileAttempt(committed: readonly (EscalationEventShape & { id: string; sequence: number })[], attempted: AttemptedEscalationEvent): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const fields: (keyof EscalationEventShape)[] = [
    'eventCode',
    'reasonCode',
    'targetMemberId',
    'escalationEventId',
    'acknowledgementEventId',
    'followupCode',
    'sourceEventId',
    'sourceEventKind',
    'returnReasonCode',
    'recordedByMembershipId',
    'recordedByUserId',
  ]
  const exact = atNumber.length === 1 && fields.every((field) => event[field] === attempted[field])
  return exact ? { outcome: 'RECORDED', escalationEventId: event.id } : { outcome: 'OTHER_EVENT' }
}
