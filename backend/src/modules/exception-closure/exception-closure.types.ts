// A8.9 — the internal closure of one A8.1 exception intake: one deliberately authorized, evidence-linked human
// confirmation that SBN's internal exception handling reached an approved terminal position, and the read-only
// reconstruction of the exact historical basis that justified it. The closure view is never stored; it is derived from
// the exact event sequence on every read. CLOSED_INTERNAL is an internal process position only: not a clinical
// determination, payer adjudication, resolved external claim, remittance, settlement, code-set compliance attestation or
// payment outcome, and it changes nothing in the intake, its triage, investigation, remediation, work, resolution or
// escalation history, the Claim or any source record. It is never inferred from A8.6 VERIFIED_INTERNAL_WORK or from an
// A8.8 RETURNED_TO_OWNER: it requires the explicit A8.7 RESOLVED_INTERNAL decision and a human confirmation.

import type { ResolutionState } from '../exception-resolution/exception-resolution.types.ts'
import type { EscalationState } from '../exception-escalation/exception-escalation.types.ts'

export const CLOSURE_CONTRACT_VERSION = 'A8-CLOSURE-1'

// §4 — the controlled vocabulary of v1 (D8). A change is a versioned A8-owned contract change.
export const closureEventCodes = ['CONFIRM_INTERNAL_CLOSURE'] as const
export type ClosureEventCode = (typeof closureEventCodes)[number]

export const closureReasonCodes = ['VERIFIED_INTERNAL_RESOLUTION', 'TERMINAL_FOLLOWUP_REVIEWED'] as const
export type ClosureReasonCode = (typeof closureReasonCodes)[number]

// D5 — the typed basis: the A8.7 confirmation itself (no escalation), or the A8.8 return of a completed escalation
// (CL-01). Each kind names its owner's contract, and each has exactly one reason.
export const basisReferenceKinds = ['RESOLUTION_DECISION', 'ESCALATION_RETURN'] as const
export type BasisReferenceKind = (typeof basisReferenceKinds)[number]
export const BASIS_OWNER_CONTRACT: Record<BasisReferenceKind, string> = {
  RESOLUTION_DECISION: 'A8-RESOLUTION-DECISION-1',
  ESCALATION_RETURN: 'A8-ESCALATION-1',
}
export const REASON_OF_BASIS: Record<BasisReferenceKind, ClosureReasonCode> = {
  RESOLUTION_DECISION: 'VERIFIED_INTERNAL_RESOLUTION',
  ESCALATION_RETURN: 'TERMINAL_FOLLOWUP_REVIEWED',
}

// The derived disposition. CLOSED_INTERNAL is terminal in v1: there is no reopening and no second closure.
export const closureStates = ['NO_CLOSURE', 'CLOSED_INTERNAL'] as const
export type ClosureState = (typeof closureStates)[number]

// D1 — the permission the confirming membership must carry now; D2 — every route also requires all seven upstream
// read permissions (A8.1, A8.2, A8.3, A8.5, A8.6, A8.7, A8.8).
export const CONFIRM_PERMISSION = 'exceptionClosure.confirm'
export const READER_PERMISSION = 'exceptionClosure.read'
export const PARENT_READ_PERMISSIONS = [
  'exceptionIntake.read',
  'exceptionTriage.read',
  'exceptionInvestigation.read',
  'exceptionRemediation.read',
  'exceptionRemediationWork.read',
  'exceptionResolution.read',
  'exceptionEscalation.read',
] as const

// §4 — the only accepted request: the event code and exactly its own controlled attributes. The actor, the membership,
// the organization, the Claim, the sequence, the time and the basis owner contract are the server's.
export type ClosureEventRequest = {
  eventCode: 'CONFIRM_INTERNAL_CLOSURE'
  resolutionDecisionEventId: string
  closureReasonCode: ClosureReasonCode
  basisReferenceKind: BasisReferenceKind
  basisReferenceId: string
}

// One event's controlled content and its actor, exactly as stored (strings: an unexpected stored value must reach the
// reducer and be refused there, not be hidden by a type).
export type ClosureEventShape = {
  eventCode: string
  resolutionDecisionEventId: string | null
  closureReasonCode: string | null
  basisReferenceKind: string | null
  basisReferenceId: string | null
  basisOwnerContractVersion: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

export type ClosureEventFacts = ClosureEventShape & {
  id: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

export type ClosureParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

// §3 — the upstream facts the eligibility gate reads, exactly as the A8.7 and A8.8 owners report them.
export type ResolutionFacts = {
  state: ResolutionState
  request: { resolutionEventId: string; requestedByMembershipId: string; requestedByUserId: string } | null
  decision: { resolutionEventId: string; decisionCode: string; decidedByMembershipId: string; decidedByUserId: string } | null
}
// The A8.8 return as its owner reports it: the event and its reason (CL-01 accepts FOLLOWUP_RECORDED only).
export type EscalationFacts = { state: EscalationState; returned: { returnEventId: string; returnReasonCode: string } | null }

// The one basis an eligible intake may be closed on, and the A8.7 actors the confirmer must be independent of.
export type EligibleBasis = {
  resolutionDecisionEventId: string
  basisReferenceKind: BasisReferenceKind
  basisReferenceId: string
  basisOwnerContractVersion: string
  closureReasonCode: ClosureReasonCode
  resolutionActors: { membershipId: string; userId: string }[]
}

export type EligibilityResult = { ok: true; basis: EligibleBasis } | { ok: false; detail: string }

export type ClosureRecord = {
  closureEventId: string
  sequence: number
  resolutionDecisionEventId: string
  closureReasonCode: ClosureReasonCode
  basisReferenceKind: BasisReferenceKind
  basisReferenceId: string
  basisOwnerContractVersion: string
  confirmedByMembershipId: string
  confirmedByUserId: string
}

export type ClosureDerived = { state: ClosureState; closure: ClosureRecord | null; lastSequence: number }

// Why the reducer refuses an event; the service maps each to its error code (D7).
export type ClosureRefusal = 'SHAPE' | 'NOT_ELIGIBLE' | 'NOT_INDEPENDENT' | 'TRANSITION_REFUSED'

export type AttemptedClosureEvent = ClosureEventShape & { sequence: number }
export type ReconciledOutcome = { outcome: 'RECORDED'; closureEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; derived: ClosureDerived } | { ok: false; refusal: ClosureRefusal; detail: string }
export type DerivationResult = { ok: true; value: ClosureDerived } | { ok: false; detail: string }

// §5 — the reconstruction. Every entry names its owner, the owner's contract, the exact immutable record id and its
// sequence; the order is canonical (A8.1 → A8.2 → A8.3 → A8.5 → A8.6 → A8.7 → A8.8 → A8.9), then the Claim's frozen
// submissions with their CRG coding status exactly as the CRG owner reports it.
export const reconstructionOwners = ['A8.1', 'A8.2', 'A8.3', 'A8.5', 'A8.6', 'A8.7', 'A8.8', 'A8.9'] as const
export type ReconstructionOwner = (typeof reconstructionOwners)[number]
export type ReconstructionEntry = { position: number; owner: ReconstructionOwner; ownerContractVersion: string; recordId: string; sequence: number | null; eventCode: string | null }
export type OwnerRecord = { recordId: string; contractVersion: string; sequence: number | null; eventCode: string | null; exceptionIntakeId: string; organizationId: string; claimId: string }
export type ReconstructionInput = {
  parent: ClosureParent
  intake: OwnerRecord
  triage: OwnerRecord[]
  investigation: OwnerRecord[]
  remediation: OwnerRecord[]
  work: OwnerRecord[]
  resolution: OwnerRecord[]
  escalation: OwnerRecord[]
  closure: OwnerRecord[]
  // The recorded closure's own facts, to be anchored in the owner histories.
  recorded: ClosureRecord | null
  // The linkage the owners report: the A8.7 request's A8.6 verification, the A8.6 verification and the plan it sits on,
  // and the plan the A8.5 owner reports as approved.
  anchors: { requestVerificationEventId: string | null; workVerificationEventId: string | null; workApprovedProposalEventId: string | null; planApprovedProposalEventId: string | null }
}
export type SubmissionEntry = { submissionId: string; submissionContractVersion: string; codingVerificationStatus: string; codingContractVersion: string }
export type ReconstructionResult = { ok: true; chain: ReconstructionEntry[] } | { ok: false; detail: string }

// §6 — the bounded DTOs: identifiers, controlled codes, the acting membership and user, and database time. No PHI,
// payload, source bytes, free text, amount, currency, payer, narrative, hash or attachment.
export type ClosureEventDto = {
  closureEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: ClosureEventCode
  resolutionDecisionEventId: string
  closureReasonCode: ClosureReasonCode
  basisReferenceKind: BasisReferenceKind
  basisReferenceId: string
  basisOwnerContractVersion: string
  recordedByMembershipId: string
  recordedByUserId: string
  recordedAt: string
}

export type ClosureHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: ClosureEventDto[]; evaluatedAt: string }

export type ClosureReconstructionDto = {
  contractVersion: string
  exceptionIntakeId: string
  state: ClosureState
  // The recorded closure itself (RECORDED_CLOSURE), told apart from the upstream decisions it rests on.
  recordedClosure: ClosureEventDto | null
  chain: ReconstructionEntry[]
  submissions: SubmissionEntry[]
  evaluatedAt: string
}

// D7 — refusals: malformed input (400); a missing or foreign Claim, intake, decision or basis (identical 404); an intake
// that is not eligible now (409: no confirmed A8.7 resolution, a pending or returned resolution, an open escalation, a
// basis that is not the intake's own, or an exception that is not assigned); a confirmer who lacks the permission now or
// is not independent of the A8.7 requester and decider (409); any event after the closure (409); a busy, conflicting,
// refused or unknown write or an inconsistent stored history (409); and a reconstruction whose owner records do not
// anchor the recorded closure (409 INTEGRITY_CONFLICT).
export type ClosureErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'EXCEPTION_CLOSURE_NOT_ELIGIBLE'
  | 'EXCEPTION_CLOSURE_NOT_INDEPENDENT'
  | 'EXCEPTION_CLOSURE_TRANSITION_REFUSED'
  | 'EXCEPTION_CLOSURE_CONFLICT'
  | 'INTEGRITY_CONFLICT'

export type ClosureResult<T> = { ok: true; value: T } | { ok: false; code: ClosureErrorCode; message: string }
