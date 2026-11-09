// A8.6 — remediation work is the append-only report-and-verification history of one A8.1 exception intake against its
// one A8.5 APPROVED_FOR_PLANNING proposal: what its current A8.2 assignee reports having done internally, citing one
// exact A8.3 investigation record, and whether an independent reviewer could verify that report from that record. The
// work view is never stored; it is derived from the exact event sequence on every read. A report is an ATTESTATION and
// a verification confirms only that the cited internal record and the report agree: nothing is executed, corrected,
// resolved, closed or escalated, no payer, patient, clinical or financial outcome is asserted, and nothing in the
// intake, its triage, investigation or remediation history, the Claim or any source record changes.

export const WORK_CONTRACT_VERSION = 'A8-REMEDIATION-WORK-1'

// §3 — the controlled vocabulary of v1. A change is a versioned A8-owned contract change.
export const workEventCodes = ['RECORD_WORK_REPORT', 'VERIFY_WORK_REPORT'] as const
export type WorkEventCode = (typeof workEventCodes)[number]

// D2 — one work code per A8.5 action code, exactly 1:1 (no second action vocabulary). No code implies clinical validity.
export const WORK_CODE_OF_ACTION = {
  REVIEW_SOURCE_PROVENANCE: 'SOURCE_PROVENANCE_REVIEWED',
  REQUEST_INTERNAL_DOCUMENTATION_CHECK: 'DOCUMENTATION_CHECK_REPORTED',
  RECHECK_CODING_REFERENCE: 'CODING_REFERENCE_REVIEW_REPORTED',
  REFER_FOR_POLICY_REVIEW: 'POLICY_REVIEW_REFERRED',
} as const
export type WorkActionCode = keyof typeof WORK_CODE_OF_ACTION
export const workCodes = ['SOURCE_PROVENANCE_REVIEWED', 'DOCUMENTATION_CHECK_REPORTED', 'CODING_REFERENCE_REVIEW_REPORTED', 'POLICY_REVIEW_REFERRED'] as const
export type WorkCode = (typeof workCodes)[number]

// D3 — the only evidence a report cites in v1: an A8.3 event of this same intake, of the kind it names. Any other kind
// is UNSUPPORTED_EVIDENCE_KIND; there is no attachment system. Both kinds are allowed for all four work codes in v1.
export const basisReferenceKinds = ['INVESTIGATION_EVIDENCE_LINK', 'INVESTIGATION_FINDING'] as const
export type BasisReferenceKind = (typeof basisReferenceKinds)[number]
export const INVESTIGATION_EVENT_OF_KIND: Record<BasisReferenceKind, string> = {
  INVESTIGATION_EVIDENCE_LINK: 'LINK_EVIDENCE_REFERENCE',
  INVESTIGATION_FINDING: 'RECORD_FINDING',
}
export const BASIS_REFERENCE_CONTRACT_VERSION = 'A8-EXCEPTION-INVESTIGATION-1'

// §3 — EVIDENCE_SUPPORTED confirms the cited internal record and the report agree; it never establishes that a payer,
// claim, billing adjustment or regulatory issue is resolved. Only EVIDENCE_NOT_VERIFIED carries a reason.
export const verificationCodes = ['EVIDENCE_SUPPORTED', 'EVIDENCE_NOT_VERIFIED'] as const
export type VerificationCode = (typeof verificationCodes)[number]
export const verificationReasonCodes = ['SOURCE_MISSING', 'SOURCE_MISMATCH', 'INSUFFICIENT_SUPPORT'] as const
export type VerificationReasonCode = (typeof verificationReasonCodes)[number]

// D8 — the derived disposition. VERIFIED_INTERNAL_WORK and NOT_VERIFIED are both terminal for a v1 approved proposal;
// there is no RESOLVED, PAID, CLOSED or EXECUTED.
export const workStates = ['NO_WORK_REPORT', 'AWAITING_VERIFICATION', 'VERIFIED_INTERNAL_WORK', 'NOT_VERIFIED'] as const
export type WorkState = (typeof workStates)[number]

// D1/D6/D7 — the permissions the acting membership must carry, beside the A8.2 assignee policy (a report) or alone (a
// verification). Neither is presumed for every Admin.
export const RECORDER_PERMISSION = 'exceptionRemediationWork.record'
export const VERIFIER_PERMISSION = 'exceptionRemediationWork.verify'
export const READER_PERMISSION = 'exceptionRemediationWork.read'

// §3 — the only accepted requests: one event code and exactly its own controlled attributes. The actor, the
// membership, the organization, the Claim, the sequence, the time and the verified plan of a verification are the
// server's.
export type WorkEventRequest =
  | { eventCode: 'RECORD_WORK_REPORT'; approvedProposalEventId: string; workCode: WorkCode; basisReferenceKind: BasisReferenceKind; basisReferenceId: string }
  | { eventCode: 'VERIFY_WORK_REPORT'; workReportEventId: string; verificationCode: VerificationCode; reasonCode: VerificationReasonCode | null }

// One event's controlled content and its actor, exactly as stored (strings: an unexpected stored value must reach the
// reducer and be refused there, not be hidden by a type). D5 — both events carry the approved plan reference.
export type WorkEventShape = {
  eventCode: string
  approvedProposalEventId: string | null
  workCode: string | null
  basisReferenceKind: string | null
  basisReferenceId: string | null
  basisReferenceContractVersion: string | null
  workReportEventId: string | null
  verificationCode: string | null
  reasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// One stored event as the reducer reads it.
export type WorkEventFacts = WorkEventShape & {
  id: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

// The parent intake every event must belong to.
export type WorkParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

// The intake's one approved A8.5 proposal, read from the A8.5 owner (null when the intake is not APPROVED_FOR_PLANNING).
// A8.5 v1 APPROVED_FOR_PLANNING is terminal, so this basis never changes once it exists.
export type ApprovedPlan = { approvedProposalEventId: string; actionCode: string }

export type WorkReportRecord = {
  workEventId: string
  sequence: number
  approvedProposalEventId: string
  workCode: WorkCode
  basisReferenceKind: BasisReferenceKind
  basisReferenceId: string
  basisReferenceContractVersion: string
  reportedByMembershipId: string
  reportedByUserId: string
}
export type VerificationRecord = {
  workEventId: string
  sequence: number
  workReportEventId: string
  verificationCode: VerificationCode
  reasonCode: VerificationReasonCode | null
  verifiedByMembershipId: string
  verifiedByUserId: string
}

// The derived work after zero or more events.
export type WorkDerived = {
  state: WorkState
  report: WorkReportRecord | null
  verification: VerificationRecord | null
  lastSequence: number
}

// An event whose commit outcome is unknown, exactly as the transaction attempted it, and what the committed history
// holds at its number (as accepted for A8.2 D12, A8.3 and A8.5).
export type AttemptedWorkEvent = WorkEventShape & { sequence: number }
export type ReconciledOutcome = { outcome: 'RECORDED'; workEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; derived: WorkDerived } | { ok: false; detail: string }
export type DerivationResult = { ok: true; value: WorkDerived } | { ok: false; detail: string }

// §5 — the bounded DTOs: identifiers, controlled codes, the acting membership and user, and database time. No PHI,
// payload, source bytes, code descriptor, amount, currency, payer, narrative, hash or attachment.
export type WorkEventDto = {
  workEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: WorkEventCode
  approvedProposalEventId: string
  workCode: WorkCode | null
  basisReferenceKind: BasisReferenceKind | null
  basisReferenceId: string | null
  basisReferenceContractVersion: string | null
  workReportEventId: string | null
  verificationCode: VerificationCode | null
  reasonCode: VerificationReasonCode | null
  recordedByMembershipId: string
  recordedByUserId: string
  recordedAt: string
}

export type WorkHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: WorkEventDto[]; evaluatedAt: string }

export type WorkDispositionDto = {
  contractVersion: string
  exceptionIntakeId: string
  state: WorkState
  // The intake's approved A8.5 proposal the work answers, or null while none exists.
  approvedProposalEventId: string | null
  report: WorkReportRecord | null
  verification: VerificationRecord | null
  eventCount: number
  lastSequence: number | null
  evaluatedAt: string
}

// D9 — refusals: malformed input (400), an unsupported evidence kind (400), a missing or foreign Claim, intake, plan or
// evidence (404), a reporter who is not the current, eligible A8.2 assignee (409), a verifier who is not independent
// of the reporter and authorized now (409), an event that is not a legal next step (409), and a busy, conflicting,
// refused or unknown write or an inconsistent stored history (409).
export type WorkErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_EVIDENCE_KIND'
  | 'NOT_FOUND'
  | 'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE'
  | 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT'
  | 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED'
  | 'EXCEPTION_REMEDIATION_WORK_CONFLICT'

export type WorkResult<T> = { ok: true; value: T } | { ok: false; code: WorkErrorCode; message: string }
