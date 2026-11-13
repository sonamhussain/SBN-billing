// A8.8 — the escalation and follow-up trail is the append-only internal-handoff history of one A8.1 exception intake
// that still needs human attention. The current A8.2 assignee escalates the exception to one nominated member of the
// same organization; only that member acknowledges it and records typed follow-ups, each citing one immutable A8.3 or
// A8.6 record of the same intake; a member independent of the escalator, the target and the current assignee returns it
// to its owner. The escalation view is never stored; it is derived from the exact event sequence on every read.
// Escalation is an INTERNAL HANDOFF only: not an emergency or clinical priority, not a payer status, not a resolution
// or closure, and it changes nothing in the intake, its triage, investigation, remediation, work or resolution history,
// the Claim or any source record. A8.7 RESOLVED_INTERNAL is never escalated or overridden.

import type { ResolutionState } from '../exception-resolution/exception-resolution.types.ts'

export const ESCALATION_CONTRACT_VERSION = 'A8-ESCALATION-1'

// §3 — the controlled vocabulary of v1 (D8). A change is a versioned A8-owned contract change.
export const escalationEventCodes = ['ESCALATE_FOR_REVIEW', 'ACKNOWLEDGE_ESCALATION', 'RECORD_FOLLOWUP', 'RETURN_TO_OWNER'] as const
export type EscalationEventCode = (typeof escalationEventCodes)[number]

export const escalationReasonCodes = ['NEEDS_SUPERVISOR_REVIEW', 'EVIDENCE_INCOMPLETE', 'POLICY_GUIDANCE_REQUIRED'] as const
export type EscalationReasonCode = (typeof escalationReasonCodes)[number]

export const followupCodes = ['SOURCE_RECHECK_RECORDED', 'ADDITIONAL_INFORMATION_REQUESTED', 'INTERNAL_POLICY_REVIEWED'] as const
export type FollowupCode = (typeof followupCodes)[number]

export const returnReasonCodes = ['FOLLOWUP_RECORDED', 'FURTHER_WORK_REQUIRED'] as const
export type ReturnReasonCode = (typeof returnReasonCodes)[number]

// D5 — the only records a follow-up may cite: an immutable A8.3 investigation event or A8.6 work event of the same
// intake, Claim and organization, verified through its owner. The kind is the server's (never the client's): it is
// established from the owner record that holds the cited id, and stored with it.
export const sourceEventKinds = ['INVESTIGATION_EVIDENCE_LINK', 'INVESTIGATION_FINDING', 'WORK_REPORT', 'WORK_VERIFICATION'] as const
export type SourceEventKind = (typeof sourceEventKinds)[number]

// The owner event code each kind is, so a cited record of any other code is UNSUPPORTED_REFERENCE.
export const SOURCE_EVENT_CODE_OF: Record<SourceEventKind, string> = {
  INVESTIGATION_EVIDENCE_LINK: 'LINK_EVIDENCE_REFERENCE',
  INVESTIGATION_FINDING: 'RECORD_FINDING',
  WORK_REPORT: 'RECORD_WORK_REPORT',
  WORK_VERIFICATION: 'VERIFY_WORK_REPORT',
}

// The derived disposition. RETURNED_TO_OWNER is terminal in v1: a further escalation cycle needs a separately
// versioned policy. One escalation cycle per intake.
export const escalationStates = ['NO_ESCALATION', 'AWAITING_ACKNOWLEDGEMENT', 'FOLLOWUP_ACTIVE', 'RETURNED_TO_OWNER'] as const
export type EscalationState = (typeof escalationStates)[number]

// D3 — the permissions the acting membership must carry. None is presumed for every Admin.
export const RAISE_PERMISSION = 'exceptionEscalation.raise'
export const HANDLE_PERMISSION = 'exceptionEscalation.handle'
export const REVIEW_PERMISSION = 'exceptionEscalation.review'
export const READER_PERMISSION = 'exceptionEscalation.read'
// The escalator is the A8.2 assignee: the A8.2 assignee policy permission, as for every earlier A8 owner.
export const ASSIGNEE_PERMISSION = 'exceptionTriage.record'

// D2 — every A8.8 route requires all six upstream read permissions (A8.1, A8.2, A8.3, A8.5, A8.6, A8.7), beside the
// route's own raise, handle, review or read permission. The nominated target must hold them too, with handle.
export const PARENT_READ_PERMISSIONS = [
  'exceptionIntake.read',
  'exceptionTriage.read',
  'exceptionInvestigation.read',
  'exceptionRemediation.read',
  'exceptionRemediationWork.read',
  'exceptionResolution.read',
] as const

// §3 — the only accepted requests: one event code and exactly its own controlled attributes. The actor, the
// membership, the organization, the Claim, the sequence, the time and the source kind are the server's.
export type EscalationEventRequest =
  | { eventCode: 'ESCALATE_FOR_REVIEW'; reasonCode: EscalationReasonCode; targetMemberId: string }
  | { eventCode: 'ACKNOWLEDGE_ESCALATION'; escalationEventId: string }
  | { eventCode: 'RECORD_FOLLOWUP'; acknowledgementEventId: string; followupCode: FollowupCode; sourceEventId: string }
  | { eventCode: 'RETURN_TO_OWNER'; escalationEventId: string; returnReasonCode: ReturnReasonCode }

// One event's controlled content and its actor, exactly as stored (strings: an unexpected stored value must reach the
// reducer and be refused there, not be hidden by a type).
export type EscalationEventShape = {
  eventCode: string
  reasonCode: string | null
  targetMemberId: string | null
  escalationEventId: string | null
  acknowledgementEventId: string | null
  followupCode: string | null
  sourceEventId: string | null
  sourceEventKind: string | null
  returnReasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// One stored event as the reducer reads it.
export type EscalationEventFacts = EscalationEventShape & {
  id: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

// The parent intake every event must belong to.
export type EscalationParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

export type EscalationRecord = {
  escalationEventId: string
  sequence: number
  reasonCode: EscalationReasonCode
  targetMemberId: string
  escalatedByMembershipId: string
  escalatedByUserId: string
}
export type AcknowledgementRecord = {
  acknowledgementEventId: string
  sequence: number
  acknowledgedByMembershipId: string
  acknowledgedByUserId: string
}
export type FollowupRecord = {
  followupEventId: string
  sequence: number
  followupCode: FollowupCode
  sourceEventId: string
  sourceEventKind: SourceEventKind
  recordedByMembershipId: string
  recordedByUserId: string
}
export type ReturnRecord = {
  returnEventId: string
  sequence: number
  returnReasonCode: ReturnReasonCode
  returnedByMembershipId: string
  returnedByUserId: string
}

// The derived escalation after zero or more events: the one escalation, its acknowledgement, its follow-ups in their
// recorded order and its return.
export type EscalationDerived = {
  state: EscalationState
  escalation: EscalationRecord | null
  acknowledgement: AcknowledgementRecord | null
  followups: FollowupRecord[]
  returned: ReturnRecord | null
  lastSequence: number
}

// Why the reducer refuses an event; the service maps each to its error code (D7).
export type EscalationRefusal = 'SHAPE' | 'TARGET_NOT_ELIGIBLE' | 'NOT_INDEPENDENT' | 'TRANSITION_REFUSED'

// An event whose commit outcome is unknown, exactly as the transaction attempted it, and what the committed history
// holds at its number (as accepted for A8.2 D12 and A8.3–A8.7).
export type AttemptedEscalationEvent = EscalationEventShape & { sequence: number }
export type ReconciledOutcome = { outcome: 'RECORDED'; escalationEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; derived: EscalationDerived } | { ok: false; refusal: EscalationRefusal; detail: string }
export type DerivationResult = { ok: true; value: EscalationDerived } | { ok: false; detail: string }

// D1 — the accepted A8.7 state an A8.8 write is judged against (read through the A8.7 owner on the write transaction).
export type UpstreamResolutionState = ResolutionState

// §4 — the bounded DTOs: identifiers, controlled codes, the acting membership and user, and database time. No PHI,
// payload, source bytes, free text, amount, currency, payer, narrative, hash or attachment.
export type EscalationEventDto = {
  escalationEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: EscalationEventCode
  reasonCode: EscalationReasonCode | null
  targetMemberId: string | null
  // The ESCALATE_FOR_REVIEW event an acknowledgement or a return names (null otherwise).
  referencedEscalationEventId: string | null
  acknowledgementEventId: string | null
  followupCode: FollowupCode | null
  sourceEventId: string | null
  sourceEventKind: SourceEventKind | null
  returnReasonCode: ReturnReasonCode | null
  recordedByMembershipId: string
  recordedByUserId: string
  recordedAt: string
}

export type EscalationHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: EscalationEventDto[]; evaluatedAt: string }

export type EscalationDispositionDto = {
  contractVersion: string
  exceptionIntakeId: string
  state: EscalationState
  escalation: EscalationRecord | null
  acknowledgement: AcknowledgementRecord | null
  followups: FollowupRecord[]
  returned: ReturnRecord | null
  eventCount: number
  lastSequence: number | null
  evaluatedAt: string
}

// D7 — refusals: malformed input or an unknown code (400); a missing or foreign Claim, intake, target member or
// source (identical 404); an escalator who is not the current, eligible A8.2 assignee (409); a target that is not an
// eligible member of the organization now, or an acknowledger or follow-up author who is not the nominated target
// (409); an actor who is not independent where independence is required (409); a cited record of an unsupported kind
// (409); an event that is not a legal next step now, including while A8.7 awaits a decision or once it is resolved
// (409); and a busy, conflicting, refused or unknown write or an inconsistent stored history (409).
export type EscalationErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'EXCEPTION_ESCALATION_NOT_ASSIGNEE'
  | 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE'
  | 'EXCEPTION_ESCALATION_NOT_INDEPENDENT'
  | 'EXCEPTION_ESCALATION_TRANSITION_REFUSED'
  | 'EXCEPTION_ESCALATION_CONFLICT'
  | 'UNSUPPORTED_REFERENCE'

export type EscalationResult<T> = { ok: true; value: T } | { ok: false; code: EscalationErrorCode; message: string }
