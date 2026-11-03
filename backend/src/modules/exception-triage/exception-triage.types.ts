// A8.2 — exception triage is the append-only internal history of one A8.1 exception intake: who classified it, to
// whom it was assigned, reassigned or returned. The current disposition is never stored; it is derived from the exact
// event sequence on every read. It is never an investigation, resolution, closure, SLA, escalation, payer outcome,
// payment or export, and it changes nothing in the intake or any source record.

export const TRIAGE_CONTRACT_VERSION = 'A8-EXCEPTION-TRIAGE-1'

// §3 — the controlled vocabulary of v1. A change is a versioned A8-owned contract change.
export const triageEventCodes = ['TRIAGE_CLASSIFY', 'ASSIGN_OWNER', 'REASSIGN_OWNER', 'RETURN_TO_TRIAGE'] as const
export type TriageEventCode = (typeof triageEventCodes)[number]

export const triageCategoryCodes = ['PROVENANCE_INTEGRITY', 'SOURCE_REFERENCE', 'CONTRACT_COMPATIBILITY', 'HISTORICAL_COHERENCE', 'HUMAN_REVIEW'] as const
export type TriageCategoryCode = (typeof triageCategoryCodes)[number]

// Internal review order only: never clinical urgency, payer status or financial exposure.
export const triagePriorityCodes = ['ROUTINE', 'ELEVATED', 'URGENT'] as const
export type TriagePriorityCode = (typeof triagePriorityCodes)[number]

export const returnReasonCodes = ['ASSIGNEE_UNAVAILABLE', 'ASSIGNMENT_INCORRECT', 'CLASSIFICATION_REVIEW_NEEDED'] as const
export type ReturnReasonCode = (typeof returnReasonCodes)[number]

export const dispositionCodes = ['UNTRIAGED', 'TRIAGED', 'ASSIGNED'] as const
export type DispositionCode = (typeof dispositionCodes)[number]

// The permission an assignee's membership must carry at the moment of assignment (approved decision 1).
export const ASSIGNEE_PERMISSION = 'exceptionTriage.record'

// §5 — the only accepted requests: one event code and exactly its own controlled attributes.
export type TriageEventRequest =
  | { eventCode: 'TRIAGE_CLASSIFY'; categoryCode: TriageCategoryCode; priorityCode: TriagePriorityCode }
  | { eventCode: 'ASSIGN_OWNER'; assignedMemberId: string }
  | { eventCode: 'REASSIGN_OWNER'; assignedMemberId: string }
  | { eventCode: 'RETURN_TO_TRIAGE'; reasonCode: ReturnReasonCode }

// One event's controlled content, exactly as stored (strings: an unexpected stored value must reach the reducer and
// be refused there, not be hidden by a type).
export type TriageEventShape = {
  eventCode: string
  categoryCode: string | null
  priorityCode: string | null
  assignedMemberId: string | null
  reasonCode: string | null
}

// One stored event as the reducer reads it.
export type TriageEventFacts = TriageEventShape & {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

// The parent intake every event must belong to.
export type TriageParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

// The derived disposition after zero or more events.
export type DispositionState = {
  dispositionCode: DispositionCode
  categoryCode: TriageCategoryCode | null
  priorityCode: TriagePriorityCode | null
  assignedMemberId: string | null
  lastSequence: number
}

// D12 — an event whose commit outcome is unknown, exactly as the transaction attempted it, and what the committed
// history holds at its number.
export type AttemptedTriageEvent = TriageEventShape & { sequence: number; recordedByUserId: string }
export type ReconciledOutcome = { outcome: 'RECORDED'; triageEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; state: DispositionState } | { ok: false; detail: string }
export type DerivationResult = { ok: true; value: DispositionState } | { ok: false; detail: string }

// §4/§5 — the bounded DTOs: identifiers, controlled codes, actor and database time. No PHI, payload, amount, payer,
// narrative, SLA, resolution or source content.
export type TriageEventDto = {
  triageEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: TriageEventCode
  categoryCode: TriageCategoryCode | null
  priorityCode: TriagePriorityCode | null
  assignedMemberId: string | null
  reasonCode: ReturnReasonCode | null
  recordedByUserId: string
  recordedAt: string
}

export type TriageHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: TriageEventDto[]; evaluatedAt: string }

export type TriageDispositionDto = {
  contractVersion: string
  exceptionIntakeId: string
  dispositionCode: DispositionCode
  categoryCode: TriageCategoryCode | null
  priorityCode: TriagePriorityCode | null
  assignedMemberId: string | null
  // D11 — the assignment is history; whether that member could be assigned NOW (same organization, roles granting
  // exceptionTriage.record) is evaluated on every read. null when nothing is assigned.
  assigneeCurrentlyEligible: boolean | null
  eventCount: number
  lastSequence: number | null
  evaluatedAt: string
}

// §5 — refusals: malformed input (400), a missing or foreign Claim or intake (404), an illegal transition (409), an
// assignee that is missing, foreign or not eligible — answered identically (409), and a busy, conflicting, refused or
// unknown write or an inconsistent stored history (409).
export type TriageErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'EXCEPTION_TRIAGE_TRANSITION_REFUSED' | 'EXCEPTION_TRIAGE_ASSIGNEE_NOT_ELIGIBLE' | 'EXCEPTION_TRIAGE_CONFLICT'

export type TriageResult<T> = { ok: true; value: T } | { ok: false; code: TriageErrorCode; message: string }
