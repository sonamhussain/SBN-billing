// A8.7 — the internal resolution decision is the append-only request-and-decision history of one A8.1 exception
// intake, grounded on its one independently verified A8.6 work record (VERIFIED_INTERNAL_WORK) and, through it, its one
// approved A8.5 plan. The current A8.2 assignee requests that the exception be treated as internally resolved; a
// different, authorized member confirms or returns that request. The resolution view is never stored; it is derived
// from the exact event sequence on every read. RESOLVED_INTERNAL is an internal decision only: it is not a payer
// acknowledgement, not revenue closure, not a cured medical or financial issue, and it changes nothing in the intake,
// its triage, investigation, remediation or work history, the Claim or any source record.

import type { RemediationDispositionDto } from '../exception-remediation/exception-remediation.types.ts'
import type { WorkDispositionDto } from '../exception-remediation-work/exception-remediation-work.types.ts'

export const RESOLUTION_CONTRACT_VERSION = 'A8-RESOLUTION-DECISION-1'

// §3 — the controlled vocabulary of v1. A change is a versioned A8-owned contract change.
export const resolutionEventCodes = ['REQUEST_INTERNAL_RESOLUTION', 'DECIDE_INTERNAL_RESOLUTION'] as const
export type ResolutionEventCode = (typeof resolutionEventCodes)[number]

// A request cites exactly one reason in v1: the A8.6 work was independently verified.
export const requestReasonCodes = ['VERIFIED_INTERNAL_WORK'] as const
export type RequestReasonCode = (typeof requestReasonCodes)[number]

export const decisionCodes = ['CONFIRM_INTERNAL_RESOLUTION', 'RETURN_FOR_REWORK'] as const
export type DecisionCode = (typeof decisionCodes)[number]

// Only a return carries a reason; a confirmation carries none.
export const returnReasonCodes = ['INSUFFICIENT_SUPPORT', 'SOURCE_INTEGRITY_CONCERN', 'ADDITIONAL_WORK_REQUIRED'] as const
export type ReturnReasonCode = (typeof returnReasonCodes)[number]

// D8 — the derived disposition. RESOLVED_INTERNAL and RETURNED_FOR_REWORK are both terminal in v1 (auditor correction
// 1): after a return any new resolution request is refused (409). Rework after a return needs a separately approved
// future version; A8.5 and A8.6 are not changed for it.
export const resolutionStates = ['NO_RESOLUTION_REQUEST', 'AWAITING_RESOLUTION_DECISION', 'RETURNED_FOR_REWORK', 'RESOLVED_INTERNAL'] as const
export type ResolutionState = (typeof resolutionStates)[number]

// D1/D4/D5 — the permissions the acting membership must carry, beside the A8.2 assignee policy (a request) or alone (a
// decision). Neither is presumed for every Admin.
export const REQUESTER_PERMISSION = 'exceptionResolution.request'
export const DECIDER_PERMISSION = 'exceptionResolution.decide'
export const READER_PERMISSION = 'exceptionResolution.read'

// Auditor correction 2 — every A8.7 route also requires all five upstream read permissions (A8.1, A8.2, A8.3, A8.5,
// A8.6), beside the route's own request, decide or read permission.
export const PARENT_READ_PERMISSIONS = [
  'exceptionIntake.read',
  'exceptionTriage.read',
  'exceptionInvestigation.read',
  'exceptionRemediation.read',
  'exceptionRemediationWork.read',
] as const

// §3 — the only accepted requests: one event code and exactly its own controlled attributes. The actor, the
// membership, the organization, the Claim, the sequence and the time are the server's.
export type ResolutionEventRequest =
  | { eventCode: 'REQUEST_INTERNAL_RESOLUTION'; verificationEventId: string; reasonCode: RequestReasonCode }
  | { eventCode: 'DECIDE_INTERNAL_RESOLUTION'; requestEventId: string; decisionCode: DecisionCode; returnReasonCode: ReturnReasonCode | null }

// One event's controlled content and its actor, exactly as stored (strings: an unexpected stored value must reach the
// reducer and be refused there, not be hidden by a type).
export type ResolutionEventShape = {
  eventCode: string
  verificationEventId: string | null
  requestEventId: string | null
  reasonCode: string | null
  decisionCode: string | null
  returnReasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// One stored event as the reducer reads it.
export type ResolutionEventFacts = ResolutionEventShape & {
  id: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

// The parent intake every event must belong to.
export type ResolutionParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

// The intake's one independently verified A8.6 work record, read from the A8.6 owner as recorded (null unless A8.6
// derives VERIFIED_INTERNAL_WORK). It is never recomputed from present permissions or present source status.
export type VerifiedBasis = { verificationEventId: string; workReportEventId: string; approvedProposalEventId: string }

// The parts of the accepted A8.6 and A8.5 dispositions the basis is read from: the A8.6 verification must sit on the
// same approved A8.5 plan the A8.5 owner reports as APPROVED_FOR_PLANNING.
export type WorkDispositionFacts = Pick<WorkDispositionDto, 'state' | 'approvedProposalEventId' | 'verification'>
export type PlanDispositionFacts = Pick<RemediationDispositionDto, 'state' | 'approvedProposalEventId'>

export type ResolutionRequestRecord = {
  resolutionEventId: string
  sequence: number
  verificationEventId: string
  reasonCode: RequestReasonCode
  requestedByMembershipId: string
  requestedByUserId: string
}
export type ResolutionDecisionRecord = {
  resolutionEventId: string
  sequence: number
  requestEventId: string
  decisionCode: DecisionCode
  returnReasonCode: ReturnReasonCode | null
  decidedByMembershipId: string
  decidedByUserId: string
}

// The derived resolution after zero or more events: the one request and its decision (null while it awaits one).
export type ResolutionDerived = {
  state: ResolutionState
  request: ResolutionRequestRecord | null
  decision: ResolutionDecisionRecord | null
  lastSequence: number
}

// Why the reducer refuses an event; the service maps each to its error code (D7).
export type ResolutionRefusal = 'SHAPE' | 'BASIS_NOT_VERIFIED' | 'REVIEWER_NOT_INDEPENDENT' | 'TRANSITION_REFUSED'

// An event whose commit outcome is unknown, exactly as the transaction attempted it, and what the committed history
// holds at its number (as accepted for A8.2 D12, A8.3, A8.5 and A8.6).
export type AttemptedResolutionEvent = ResolutionEventShape & { sequence: number }
export type ReconciledOutcome = { outcome: 'RECORDED'; resolutionEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; derived: ResolutionDerived } | { ok: false; refusal: ResolutionRefusal; detail: string }
export type DerivationResult = { ok: true; value: ResolutionDerived } | { ok: false; detail: string }

// §6 — the bounded DTOs: identifiers, controlled codes, the acting membership and user, and database time. No PHI,
// payload, source bytes, code descriptor, amount, currency, payer, narrative, hash or attachment.
export type ResolutionEventDto = {
  resolutionEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: ResolutionEventCode
  verificationEventId: string | null
  requestEventId: string | null
  reasonCode: RequestReasonCode | null
  decisionCode: DecisionCode | null
  returnReasonCode: ReturnReasonCode | null
  recordedByMembershipId: string
  recordedByUserId: string
  recordedAt: string
}

export type ResolutionHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: ResolutionEventDto[]; evaluatedAt: string }

export type ResolutionDispositionDto = {
  contractVersion: string
  exceptionIntakeId: string
  state: ResolutionState
  // The intake's verified A8.6 work record a request may cite, or null while none exists.
  verificationEventId: string | null
  request: ResolutionRequestRecord | null
  decision: ResolutionDecisionRecord | null
  eventCount: number
  lastSequence: number | null
  evaluatedAt: string
}

// D7 — refusals: malformed input (400), a missing or foreign Claim, intake or verification (404), a requester who is
// not the current, eligible A8.2 assignee (409), a decider who is not independent of the requester and authorized now
// (409), a request or decision without the exact verified A8.6 basis (409), an event that is not a legal next step
// (409), and a busy, conflicting, refused or unknown write or an inconsistent stored history (409).
export type ResolutionErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'EXCEPTION_RESOLUTION_NOT_ASSIGNEE'
  | 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT'
  | 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED'
  | 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED'
  | 'EXCEPTION_RESOLUTION_CONFLICT'

export type ResolutionResult<T> = { ok: true; value: T } | { ok: false; code: ResolutionErrorCode; message: string }
