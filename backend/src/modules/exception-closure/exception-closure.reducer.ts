import {
  type AttemptedClosureEvent,
  BASIS_OWNER_CONTRACT,
  type BasisReferenceKind,
  CLOSURE_CONTRACT_VERSION,
  type ClosureDerived,
  type ClosureEventFacts,
  type ClosureEventShape,
  type ClosureParent,
  type ClosureReasonCode,
  type ClosureRefusal,
  type DerivationResult,
  type EligibilityResult,
  type EligibleBasis,
  type EscalationFacts,
  type OwnerRecord,
  REASON_OF_BASIS,
  type ReconciledOutcome,
  type ReconstructionEntry,
  type ReconstructionInput,
  type ReconstructionOwner,
  type ReconstructionResult,
  type ResolutionFacts,
  type TransitionResult,
  basisReferenceKinds,
  closureReasonCodes,
} from './exception-closure.types.ts'

// A8.9 §3–§5 — the pure, deterministic closure gate, history reducer and reconstruction. They read the upstream facts
// as their owners report them and the closure history, and answer eligibility, the closure after an event, or the
// ordered basis of a recorded closure. They never read a clock, locale, time zone, database or network, never order by
// time or identifier, and never repair: an ineligible upstream position, a basis that is not the intake's own, a
// confirmer who is not independent, a second closure, a gap, a foreign record or an unknown contract is a refusal.
//
//   NO_CLOSURE + CONFIRM_INTERNAL_CLOSURE (eligible, exact basis, independent confirmer) -> CLOSED_INTERNAL (terminal)
//
// Eligibility (§3, CL-01, CL-02): A8.7 must be RESOLVED_INTERNAL by a confirmed decision; with A8.8 NO_ESCALATION the
// basis is that decision (VERIFIED_INTERNAL_RESOLUTION); with A8.8 RETURNED_TO_OWNER for FOLLOWUP_RECORDED it is the
// escalation's return (TERMINAL_FOLLOWUP_REVIEWED); a return for FURTHER_WORK_REQUIRED (v1), an escalation awaiting
// acknowledgement or with follow-ups active, a pending or returned resolution and no resolution at all are each refused. Whether the intake is assigned and the confirmer holds the
// permission now are the service's and the database's to hold at write time.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidShape.test(value)
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const refuse = (refusal: ClosureRefusal, detail: string): TransitionResult => ({ ok: false, refusal, detail })

export const NO_CLOSURE: ClosureDerived = { state: 'NO_CLOSURE', closure: null, lastSequence: 0 }

// §3 — the one basis this intake may be closed on now, or why it may not.
export function eligibilityOf(resolution: ResolutionFacts, escalation: EscalationFacts): EligibilityResult {
  if (resolution.state === 'AWAITING_RESOLUTION_DECISION') return { ok: false, detail: 'an A8.7 resolution request awaits a decision; the exception has no internal resolution' }
  if (resolution.state === 'RETURNED_FOR_REWORK') return { ok: false, detail: 'the A8.7 resolution request was returned for rework; the exception has no internal resolution' }
  if (resolution.state !== 'RESOLVED_INTERNAL') return { ok: false, detail: 'the exception has no confirmed A8.7 internal resolution; it is never closed without one' }
  const { request, decision } = resolution
  if (!request || !decision || decision.decisionCode !== 'CONFIRM_INTERNAL_RESOLUTION' || !isUuid(decision.resolutionEventId))
    return { ok: false, detail: "the exception's A8.7 resolution does not name its confirmed decision; nothing is inferred" }
  const resolutionActors = [
    { membershipId: request.requestedByMembershipId, userId: request.requestedByUserId },
    { membershipId: decision.decidedByMembershipId, userId: decision.decidedByUserId },
  ]
  const basisOf = (kind: BasisReferenceKind, basisReferenceId: string): EligibleBasis => ({
    resolutionDecisionEventId: decision.resolutionEventId,
    basisReferenceKind: kind,
    basisReferenceId,
    basisOwnerContractVersion: BASIS_OWNER_CONTRACT[kind],
    closureReasonCode: REASON_OF_BASIS[kind],
    resolutionActors,
  })
  if (escalation.state === 'NO_ESCALATION') return { ok: true, basis: basisOf('RESOLUTION_DECISION', decision.resolutionEventId) }
  if (escalation.state === 'RETURNED_TO_OWNER' && escalation.returned && isUuid(escalation.returned.returnEventId)) {
    // CL-01: only a return because the follow-up was recorded is a closure basis.
    if (escalation.returned.returnReasonCode === 'FOLLOWUP_RECORDED') return { ok: true, basis: basisOf('ESCALATION_RETURN', escalation.returned.returnEventId) }
    if (escalation.returned.returnReasonCode === 'FURTHER_WORK_REQUIRED')
      return { ok: false, detail: "the exception's A8.8 escalation was returned because further work is required (FURTHER_WORK_REQUIRED); it is not closed in v1" }
    return { ok: false, detail: "the exception's A8.8 return does not name a controlled reason; nothing is inferred" }
  }
  if (escalation.state === 'RETURNED_TO_OWNER') return { ok: false, detail: "the exception's A8.8 escalation does not name its return; nothing is inferred" }
  return { ok: false, detail: `the exception's A8.8 escalation is ${escalation.state}: it is still outstanding, so the exception is not closed` }
}

// The exact shape of the event: every field present and controlled, the reason and the basis owner contract exactly the
// ones its basis kind names.
function shapeRefusal(event: ClosureEventShape): string | null {
  if (!isUuid(event.recordedByMembershipId) || !isUuid(event.recordedByUserId)) return 'an event names its acting membership and user'
  if (event.eventCode !== 'CONFIRM_INTERNAL_CLOSURE') return 'the event code is not a controlled closure event'
  const kind = event.basisReferenceKind
  return isUuid(event.resolutionDecisionEventId) && isUuid(event.basisReferenceId) && oneOf(basisReferenceKinds, kind) && oneOf(closureReasonCodes, event.closureReasonCode) &&
    event.closureReasonCode === REASON_OF_BASIS[kind] && event.basisOwnerContractVersion === BASIS_OWNER_CONTRACT[kind] &&
    (kind !== 'RESOLUTION_DECISION' || event.basisReferenceId === event.resolutionDecisionEventId)
    ? null
    : 'a closure carries exactly the confirmed A8.7 decision, a typed basis of a controlled kind with its owner contract, and the reason that kind names'
}

// A recorded event, judged as history: its shape, and that no closure came before it.
export function applyRecordedClosure(before: ClosureDerived, event: ClosureEventShape, id: string | null = null): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return refuse('SHAPE', shape)
  if (before.state === 'CLOSED_INTERNAL') return refuse('TRANSITION_REFUSED', 'the exception is CLOSED_INTERNAL, which is terminal in v1; no further closure event is recorded')
  const sequence = before.lastSequence + 1
  return {
    ok: true,
    derived: {
      state: 'CLOSED_INTERNAL',
      closure: {
        closureEventId: id ?? '',
        sequence,
        resolutionDecisionEventId: event.resolutionDecisionEventId as string,
        closureReasonCode: event.closureReasonCode as ClosureReasonCode,
        basisReferenceKind: event.basisReferenceKind as BasisReferenceKind,
        basisReferenceId: event.basisReferenceId as string,
        basisOwnerContractVersion: event.basisOwnerContractVersion as string,
        confirmedByMembershipId: event.recordedByMembershipId,
        confirmedByUserId: event.recordedByUserId,
      },
      lastSequence: sequence,
    },
  }
}

// A new closure, judged against the upstream position now: eligible, naming exactly the intake's basis, by a confirmer
// independent of the A8.7 requester and decider (D1).
export function applyNewClosure(before: ClosureDerived, eligibility: EligibilityResult, event: ClosureEventShape): TransitionResult {
  const recorded = applyRecordedClosure(before, event)
  if (!recorded.ok) return recorded
  if (!eligibility.ok) return refuse('NOT_ELIGIBLE', eligibility.detail)
  const basis = eligibility.basis
  if (event.resolutionDecisionEventId !== basis.resolutionDecisionEventId) return refuse('NOT_ELIGIBLE', "a closure names exactly the exception's confirmed A8.7 decision")
  if (event.basisReferenceKind !== basis.basisReferenceKind || event.basisReferenceId !== basis.basisReferenceId)
    return refuse('NOT_ELIGIBLE', `a closure names exactly the exception's basis: ${basis.basisReferenceKind === 'RESOLUTION_DECISION' ? 'its A8.7 confirmation (no escalation)' : 'the return of its completed A8.8 escalation'}`)
  if (basis.resolutionActors.some((actor) => actor.membershipId === event.recordedByMembershipId || actor.userId === event.recordedByUserId))
    return refuse('NOT_INDEPENDENT', "an exception is never closed by its A8.7 resolution's own requester or decider")
  return recorded
}

// §6 — the closure of one intake from its stored events, in the order the store returned them. Every event must belong to
// exactly this intake, organization and Claim, under this contract, numbered exactly 1..N in that order, and each must
// be a legal step as history; anything else refuses the whole history (never a partial or guessed view).
export function deriveClosure(parent: ClosureParent, events: readonly ClosureEventFacts[]): DerivationResult {
  let derived = NO_CLOSURE
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'a closure event belongs to another intake, organization or claim' }
    if (event.contractVersion !== CLOSURE_CONTRACT_VERSION) return { ok: false, detail: 'a closure event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the closure events are not numbered exactly 1..N' }
    if (!isUuid(event.id)) return { ok: false, detail: 'a closure event has no valid identity' }
    const next = applyRecordedClosure(derived, event, event.id)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal step: ${next.detail}` }
    derived = next.derived
  }
  return { ok: true, value: derived }
}

// An attempt whose commit outcome is unknown, judged against the committed history only (never a guess, never a reason to
// write again).
export function reconcileAttempt(committed: readonly (ClosureEventShape & { id: string; sequence: number })[], attempted: AttemptedClosureEvent): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const fields: (keyof ClosureEventShape)[] = [
    'eventCode', 'resolutionDecisionEventId', 'closureReasonCode', 'basisReferenceKind', 'basisReferenceId', 'basisOwnerContractVersion', 'recordedByMembershipId', 'recordedByUserId',
  ]
  const exact = atNumber.length === 1 && fields.every((field) => event[field] === attempted[field])
  return exact ? { outcome: 'RECORDED', closureEventId: event.id } : { outcome: 'OTHER_EVENT' }
}

// §5 — the ordered basis of the recorded closure, built from the owner histories exactly as their owners report them.
// Every record must belong to this intake, organization and Claim and every owner history must be numbered 1..N; the
// recorded closure must be anchored: its A8.7 decision a CONFIRM decision in the A8.7 history, its basis that decision or
// the A8.8 return in the A8.8 history, the A8.7 request's verification the A8.6 verification, which sits on the plan the
// A8.5 owner reports as approved. Anything absent, ambiguous or foreign is refused whole (INTEGRITY_CONFLICT upstream).
export function buildReconstruction(input: ReconstructionInput): ReconstructionResult {
  const { parent, recorded, anchors } = input
  const belongs = (record: OwnerRecord) => record.exceptionIntakeId === parent.exceptionIntakeId && record.organizationId === parent.organizationId && record.claimId === parent.claimId && isUuid(record.recordId)
  const groups: [ReconstructionOwner, OwnerRecord[]][] = [
    ['A8.1', [input.intake]], ['A8.2', input.triage], ['A8.3', input.investigation], ['A8.5', input.remediation], ['A8.6', input.work], ['A8.7', input.resolution], ['A8.8', input.escalation],
    ['A8.9', input.closure],
  ]
  for (const [owner, records] of groups) {
    if (!records.every(belongs)) return { ok: false, detail: `an ${owner} record belongs to another intake, organization or claim` }
    if (owner !== 'A8.1' && !records.every((record, i) => record.sequence === i + 1)) return { ok: false, detail: `the ${owner} history is not numbered exactly 1..N` }
    if (new Set(records.map((record) => record.recordId)).size !== records.length) return { ok: false, detail: `the ${owner} history repeats a record` }
  }
  if (!recorded) return input.closure.length === 0 ? { ok: true, chain: [] } : { ok: false, detail: 'a stored closure event was not derived' }
  const has = (records: OwnerRecord[], id: string | null, eventCode: string) => !!id && records.some((record) => record.recordId === id && record.eventCode === eventCode)
  if (!input.closure.some((record) => record.recordId === recorded.closureEventId)) return { ok: false, detail: 'the recorded closure is not in the closure history' }
  if (!has(input.resolution, recorded.resolutionDecisionEventId, 'DECIDE_INTERNAL_RESOLUTION')) return { ok: false, detail: "the recorded closure's A8.7 decision is not in the A8.7 history" }
  const basisAnchored =
    recorded.basisReferenceKind === 'RESOLUTION_DECISION'
      ? recorded.basisReferenceId === recorded.resolutionDecisionEventId && input.escalation.length === 0
      : has(input.escalation, recorded.basisReferenceId, 'RETURN_TO_OWNER')
  if (!basisAnchored) return { ok: false, detail: "the recorded closure's basis is not anchored in its owner's history" }
  if (!has(input.work, anchors.requestVerificationEventId, 'VERIFY_WORK_REPORT') || anchors.requestVerificationEventId !== anchors.workVerificationEventId)
    return { ok: false, detail: "the A8.7 request's A8.6 verification is not the intake's verified work" }
  if (!has(input.remediation, anchors.workApprovedProposalEventId, 'PROPOSE_ACTION') || anchors.workApprovedProposalEventId !== anchors.planApprovedProposalEventId)
    return { ok: false, detail: 'the verified A8.6 work does not sit on the plan the A8.5 owner reports as approved' }
  if (input.triage.length === 0 || input.investigation.length === 0) return { ok: false, detail: 'the A8.2 or A8.3 history the resolution rests on is missing' }
  const chain: ReconstructionEntry[] = []
  for (const [owner, records] of groups)
    for (const record of records) chain.push({ position: chain.length + 1, owner, ownerContractVersion: record.contractVersion, recordId: record.recordId, sequence: record.sequence, eventCode: record.eventCode })
  return { ok: true, chain }
}
