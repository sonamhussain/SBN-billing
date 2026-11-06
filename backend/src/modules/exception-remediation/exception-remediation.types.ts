// A8.5 — exception remediation is the append-only proposal-and-review history of one A8.1 exception intake: which
// controlled next action its current A8.2 assignee proposed on the strength of one exact A8.3 finding, and what an
// independent reviewer decided about that proposal. The remediation view is never stored; it is derived from the exact
// event sequence on every read. An approval is internal planning authorization only: nothing is executed, corrected,
// resolved, closed or escalated, no payer, patient or financial outcome is asserted, and nothing in the intake, its
// triage or investigation history, the Claim or any source record changes.

export const REMEDIATION_CONTRACT_VERSION = 'A8-REMEDIATION-PLAN-1'

// §3 — the controlled vocabulary of v1. A change is a versioned A8-owned contract change.
export const remediationEventCodes = ['PROPOSE_ACTION', 'REVIEW_ACTION'] as const
export type RemediationEventCode = (typeof remediationEventCodes)[number]

// RECHECK_CODING_REFERENCE is an internal request for review only: it selects no code set, changes no A2/A3/A5 record,
// triggers no CRG-01 work and implies no DHA compliance.
export const actionCodes = ['REVIEW_SOURCE_PROVENANCE', 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'RECHECK_CODING_REFERENCE', 'REFER_FOR_POLICY_REVIEW'] as const
export type ActionCode = (typeof actionCodes)[number]

export const rationaleCodes = ['RECORDED_CONFLICT', 'INSUFFICIENT_EVIDENCE', 'POLICY_CLARIFICATION_NEEDED'] as const
export type RationaleCode = (typeof rationaleCodes)[number]

export const decisionCodes = ['APPROVE_PROPOSAL', 'RETURN_PROPOSAL'] as const
export type DecisionCode = (typeof decisionCodes)[number]

// Only a RETURN_PROPOSAL carries a reason; an APPROVE_PROPOSAL carries none.
export const reviewReasonCodes = ['INSUFFICIENT_SUPPORT', 'WRONG_SCOPE', 'NEEDS_MORE_INVESTIGATION'] as const
export type ReviewReasonCode = (typeof reviewReasonCodes)[number]

// The derived disposition. APPROVED_FOR_PLANNING is terminal for a v1 intake; there is no EXECUTED, RESOLVED or CLOSED.
export const remediationStates = ['NO_PROPOSAL', 'AWAITING_REVIEW', 'APPROVED_FOR_PLANNING', 'RETURNED_FOR_REVISION'] as const
export type RemediationState = (typeof remediationStates)[number]

// R2 — the permissions the acting membership must carry, beside the A8.2 assignee policy (a proposal) or alone (a
// review). Neither is presumed for every Admin: a proposal also needs the current, eligible A8.2 assignment.
export const PROPOSER_PERMISSION = 'exceptionRemediation.propose'
export const REVIEWER_PERMISSION = 'exceptionRemediation.review'

// §3/§4 — the only accepted requests: one event code and exactly its own controlled attributes. The actor, the
// membership, the organization, the Claim, the sequence and the time are the server's.
export type RemediationEventRequest =
  | { eventCode: 'PROPOSE_ACTION'; actionCode: ActionCode; findingEventId: string; rationaleCode: RationaleCode }
  | { eventCode: 'REVIEW_ACTION'; proposalEventId: string; decisionCode: DecisionCode; reviewReasonCode: ReviewReasonCode | null }

// One event's controlled content and its actor, exactly as stored (strings: an unexpected stored value must reach the
// reducer and be refused there, not be hidden by a type).
export type RemediationEventShape = {
  eventCode: string
  actionCode: string | null
  findingEventId: string | null
  rationaleCode: string | null
  proposalEventId: string | null
  decisionCode: string | null
  reviewReasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// One stored event as the reducer reads it.
export type RemediationEventFacts = RemediationEventShape & {
  id: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

// The parent intake every event must belong to.
export type RemediationParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

export type ProposalRecord = {
  remediationEventId: string
  sequence: number
  actionCode: ActionCode
  findingEventId: string
  rationaleCode: RationaleCode
  proposedByMembershipId: string
  proposedByUserId: string
}
export type DecisionRecord = {
  remediationEventId: string
  sequence: number
  proposalEventId: string
  decisionCode: DecisionCode
  reviewReasonCode: ReviewReasonCode | null
  reviewedByMembershipId: string
  reviewedByUserId: string
}

// The derived remediation after zero or more events.
export type RemediationDerived = {
  state: RemediationState
  proposals: ProposalRecord[]
  decisions: DecisionRecord[]
  // The proposal awaiting review, or null.
  pendingProposal: ProposalRecord | null
  lastSequence: number
}

// An event whose commit outcome is unknown, exactly as the transaction attempted it, and what the committed history
// holds at its number (as accepted for A8.2, D12, and A8.3).
export type AttemptedRemediationEvent = RemediationEventShape & { sequence: number }
export type ReconciledOutcome = { outcome: 'RECORDED'; remediationEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; derived: RemediationDerived } | { ok: false; detail: string }
export type DerivationResult = { ok: true; value: RemediationDerived } | { ok: false; detail: string }

// §6 — the bounded DTOs: identifiers, controlled codes, the acting membership and user, and database time. No PHI,
// payload, source bytes, code descriptor, amount, currency, payer, narrative, hash or attachment.
export type RemediationEventDto = {
  remediationEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: RemediationEventCode
  actionCode: ActionCode | null
  findingEventId: string | null
  rationaleCode: RationaleCode | null
  proposalEventId: string | null
  decisionCode: DecisionCode | null
  reviewReasonCode: ReviewReasonCode | null
  recordedByMembershipId: string
  recordedByUserId: string
  recordedAt: string
}

export type RemediationHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: RemediationEventDto[]; evaluatedAt: string }

export type RemediationDispositionDto = {
  contractVersion: string
  exceptionIntakeId: string
  state: RemediationState
  pendingProposal: ProposalRecord | null
  // The decision with the highest sequence, or null.
  latestDecision: DecisionRecord | null
  // The approved proposal once APPROVED_FOR_PLANNING, or null. Planning authorization only, never execution.
  approvedProposalEventId: string | null
  proposalCount: number
  eventCount: number
  lastSequence: number | null
  evaluatedAt: string
}

// §6 — refusals: malformed input (400), a missing or foreign Claim, intake or finding (404), a proposer who is not the
// current, eligible A8.2 assignee (409), a reviewer who is not independent and authorized now (409), an event that is
// not a legal next step (409), and a busy, conflicting, refused or unknown write or an inconsistent stored history (409).
export type RemediationErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'EXCEPTION_REMEDIATION_NOT_ASSIGNEE'
  | 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT'
  | 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED'
  | 'EXCEPTION_REMEDIATION_CONFLICT'

export type RemediationResult<T> = { ok: true; value: T } | { ok: false; code: RemediationErrorCode; message: string }
