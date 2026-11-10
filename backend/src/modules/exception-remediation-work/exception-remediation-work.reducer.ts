import {
  type ApprovedPlan,
  type AttemptedWorkEvent,
  BASIS_REFERENCE_CONTRACT_VERSION,
  type BasisReferenceKind,
  type DerivationResult,
  type ReconciledOutcome,
  type TransitionResult,
  type VerificationCode,
  type VerificationReasonCode,
  WORK_CODE_OF_ACTION,
  WORK_CONTRACT_VERSION,
  type WorkCode,
  type WorkDerived,
  type WorkEventFacts,
  type WorkEventShape,
  type WorkParent,
  type WorkReportRecord,
  basisReferenceKinds,
  verificationCodes,
  verificationReasonCodes,
  workCodes,
} from './exception-remediation-work.types.ts'

// A8.6 §3/§4 — the one pure, deterministic work reducer. It reads an event's controlled content, its actor, the
// intake's approved A8.5 plan and the work before it, and answers the work after it or a refusal. It never reads a
// clock, locale, database or network, never orders by time or identifier, and never repairs: an event of the wrong
// shape, a report against anything but the approved plan or with a work code that is not the plan's own, a
// verification of anything but the outstanding report, a self-verification, a gap, a reused or out-of-order sequence,
// another intake's or tenant's event or an unknown contract is a refusal.
//
//   NO_WORK_REPORT        + RECORD_WORK_REPORT                         -> AWAITING_VERIFICATION
//   AWAITING_VERIFICATION + VERIFY_WORK_REPORT(EVIDENCE_SUPPORTED)     -> VERIFIED_INTERNAL_WORK (terminal)
//   AWAITING_VERIFICATION + VERIFY_WORK_REPORT(EVIDENCE_NOT_VERIFIED)  -> NOT_VERIFIED (terminal)
// Anything else is refused: a report without an approved plan, a second report while one awaits verification, a
// verification with nothing outstanding or of another report, a verification by the report's own membership or user
// (D7: the A8.5 approver may verify), and any event after a terminal verification (D8: one report per approved plan).
// Whether the reporter is the current A8.2 assignee, the verifier holds the verify permission now, and the cited A8.3
// record exists under its kind for this intake are the service's and the database's to hold; the reducer judges the
// history.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidShape.test(value)
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

export const NO_WORK_REPORT: WorkDerived = { state: 'NO_WORK_REPORT', report: null, verification: null, lastSequence: 0 }

// D2 — the work code that answers an approved A8.5 action, or null for an action outside the A8.5 v1 vocabulary.
export function workCodeForAction(actionCode: string): WorkCode | null {
  return Object.hasOwn(WORK_CODE_OF_ACTION, actionCode) ? WORK_CODE_OF_ACTION[actionCode as keyof typeof WORK_CODE_OF_ACTION] : null
}

// The exact shape of each event: its own attributes present and controlled, every other attribute null. Both events
// carry the approved plan; only EVIDENCE_NOT_VERIFIED carries a reason.
function shapeRefusal(event: WorkEventShape): string | null {
  const { eventCode, approvedProposalEventId, workCode, basisReferenceKind, basisReferenceId, basisReferenceContractVersion, workReportEventId, verificationCode, reasonCode } = event
  if (!isUuid(event.recordedByMembershipId) || !isUuid(event.recordedByUserId)) return 'an event names its acting membership and user'
  if (!isUuid(approvedProposalEventId)) return 'an event names the approved A8.5 proposal it answers'
  if (eventCode === 'RECORD_WORK_REPORT')
    return oneOf(workCodes, workCode) &&
      oneOf(basisReferenceKinds, basisReferenceKind) &&
      isUuid(basisReferenceId) &&
      basisReferenceContractVersion === BASIS_REFERENCE_CONTRACT_VERSION &&
      workReportEventId === null &&
      verificationCode === null &&
      reasonCode === null
      ? null
      : 'a work report carries exactly one controlled work code and one A8.3 record of a controlled kind under its contract'
  if (eventCode === 'VERIFY_WORK_REPORT') {
    const reasonOk = verificationCode === 'EVIDENCE_NOT_VERIFIED' ? oneOf(verificationReasonCodes, reasonCode) : verificationCode === 'EVIDENCE_SUPPORTED' && reasonCode === null
    return isUuid(workReportEventId) && oneOf(verificationCodes, verificationCode) && reasonOk && workCode === null && basisReferenceKind === null && basisReferenceId === null && basisReferenceContractVersion === null
      ? null
      : 'a verification carries exactly one work report, a controlled verification code and, when not verified only, a controlled reason'
  }
  return 'the event code is not a controlled remediation work event'
}

// The next event, given the work before it and the intake's approved plan (null when none exists). `id` is the
// event's own stored id (null for an event not yet written): a later verification names a report by it.
export function applyWorkEvent(before: WorkDerived, plan: ApprovedPlan | null, event: WorkEventShape, id: string | null = null): TransitionResult {
  const shape = shapeRefusal(event)
  if (shape) return { ok: false, detail: shape }
  const sequence = before.lastSequence + 1
  if (before.state === 'VERIFIED_INTERNAL_WORK' || before.state === 'NOT_VERIFIED')
    return { ok: false, detail: 'the work report of this exception was verified or not verified; no further work event is recorded in v1' }
  if (!plan) return { ok: false, detail: 'the exception has no A8.5 proposal approved for planning; no work is recorded against it' }
  if (event.approvedProposalEventId !== plan.approvedProposalEventId) return { ok: false, detail: "an event names exactly the exception's approved A8.5 proposal" }
  if (event.eventCode === 'RECORD_WORK_REPORT') {
    if (before.state === 'AWAITING_VERIFICATION') return { ok: false, detail: 'a work report already awaits verification; a second report is not recorded' }
    if (event.workCode !== workCodeForAction(plan.actionCode)) return { ok: false, detail: "the work code is not the one that answers the approved proposal's action" }
    const report: WorkReportRecord = {
      workEventId: id ?? '',
      sequence,
      approvedProposalEventId: plan.approvedProposalEventId,
      workCode: event.workCode as WorkCode,
      basisReferenceKind: event.basisReferenceKind as BasisReferenceKind,
      basisReferenceId: event.basisReferenceId as string,
      basisReferenceContractVersion: event.basisReferenceContractVersion as string,
      reportedByMembershipId: event.recordedByMembershipId,
      reportedByUserId: event.recordedByUserId,
    }
    return { ok: true, derived: { state: 'AWAITING_VERIFICATION', report, verification: null, lastSequence: sequence } }
  }
  const report = before.report
  if (before.state !== 'AWAITING_VERIFICATION' || !report) return { ok: false, detail: 'no work report of this exception awaits verification' }
  if (event.workReportEventId !== report.workEventId) return { ok: false, detail: 'a verification names exactly the work report that awaits verification' }
  if (event.recordedByMembershipId === report.reportedByMembershipId || event.recordedByUserId === report.reportedByUserId)
    return { ok: false, detail: "a work report is never verified by its own reporter's membership or user" }
  const verification = {
    workEventId: id ?? '',
    sequence,
    workReportEventId: report.workEventId,
    verificationCode: event.verificationCode as VerificationCode,
    reasonCode: event.reasonCode as VerificationReasonCode | null,
    verifiedByMembershipId: event.recordedByMembershipId,
    verifiedByUserId: event.recordedByUserId,
  }
  return {
    ok: true,
    derived: { state: verification.verificationCode === 'EVIDENCE_SUPPORTED' ? 'VERIFIED_INTERNAL_WORK' : 'NOT_VERIFIED', report, verification, lastSequence: sequence },
  }
}

// §7 — the work of one intake from its stored events, in the order the store returned them, against the intake's
// approved plan. Every event must belong to exactly this intake, organization and Claim, under this contract, numbered
// exactly 1..N in that order, and each must be a legal next step; anything else refuses the whole history (never a
// partial or guessed view). Stored work without an approved plan is itself inconsistent.
export function deriveWork(parent: WorkParent, plan: ApprovedPlan | null, events: readonly WorkEventFacts[]): DerivationResult {
  let derived = NO_WORK_REPORT
  for (const [index, event] of events.entries()) {
    if (event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId)
      return { ok: false, detail: 'a work event belongs to another intake, organization or claim' }
    if (event.contractVersion !== WORK_CONTRACT_VERSION) return { ok: false, detail: 'a work event is under an unknown contract version' }
    if (event.sequence !== index + 1) return { ok: false, detail: 'the work events are not numbered exactly 1..N' }
    if (!isUuid(event.id)) return { ok: false, detail: 'a work event has no valid identity' }
    const next = applyWorkEvent(derived, plan, event, event.id)
    if (!next.ok) return { ok: false, detail: `event ${event.sequence} is not a legal step: ${next.detail}` }
    derived = next.derived
  }
  return { ok: true, value: derived }
}

// An attempt whose commit outcome is unknown, judged against the committed history only: RECORDED when the event at
// the attempted number is exactly this one (membership, actor and every controlled field), OTHER_EVENT when another
// event holds that number, NOT_RECORDED when none does. Never a guess from a time or an id, and never a reason to
// write again.
export function reconcileAttempt(committed: readonly (WorkEventShape & { id: string; sequence: number })[], attempted: AttemptedWorkEvent): ReconciledOutcome {
  const atNumber = committed.filter((event) => event.sequence === attempted.sequence)
  if (atNumber.length === 0) return { outcome: 'NOT_RECORDED' }
  const [event] = atNumber
  const fields: (keyof WorkEventShape)[] = [
    'eventCode',
    'approvedProposalEventId',
    'workCode',
    'basisReferenceKind',
    'basisReferenceId',
    'basisReferenceContractVersion',
    'workReportEventId',
    'verificationCode',
    'reasonCode',
    'recordedByMembershipId',
    'recordedByUserId',
  ]
  const exact = atNumber.length === 1 && fields.every((field) => event[field] === attempted[field])
  return exact ? { outcome: 'RECORDED', workEventId: event.id } : { outcome: 'OTHER_EVENT' }
}
