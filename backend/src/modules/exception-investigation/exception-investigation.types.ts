// A8.3 — exception investigation is the append-only evidence history of one A8.1 exception intake: which exact,
// immutable owner record was checked, and which controlled finding that evidence supported at the time. The
// investigation view is never stored; it is derived from the exact event sequence on every read. It never assigns,
// resolves, closes or escalates an exception, never asserts a payer, denial, payment or financial outcome, and changes
// nothing in the intake, its triage history or any source record.

export const INVESTIGATION_CONTRACT_VERSION = 'A8-EXCEPTION-INVESTIGATION-1'

// §3/§4 — the controlled vocabulary of v1. A change is a versioned A8-owned contract change.
export const investigationEventCodes = ['LINK_EVIDENCE_REFERENCE', 'RECORD_FINDING'] as const
export type InvestigationEventCode = (typeof investigationEventCodes)[number]

// The approved evidence kinds, each with the one owner contract it is accepted under (D15):
//   INTAKE_BASIS       — the parent intake's own stored basis record, under the A8.1 contract
//   TRIAGE_EVENT       — an A8.2 triage event of the same intake
//   A7_CASE_ASSESSMENT — an A7.5 closure-prerequisite assessment of a case of the same Claim and organization
export const evidenceKinds = ['INTAKE_BASIS', 'TRIAGE_EVENT', 'A7_CASE_ASSESSMENT'] as const
export type EvidenceKind = (typeof evidenceKinds)[number]

export const EVIDENCE_CONTRACT_OF: Record<EvidenceKind, string> = {
  INTAKE_BASIS: 'A8-EXCEPTION-INTAKE-1',
  TRIAGE_EVENT: 'A8-EXCEPTION-TRIAGE-1',
  A7_CASE_ASSESSMENT: 'A7-CLOSURE-PREREQ-1',
}

// A finding is an observation about the linked evidence — never proof of loss, denial, overpayment, liability or a
// financial shortfall, and never a resolution.
export const findingCodes = ['EVIDENCE_CONFIRMS_RECORDED_CONFLICT', 'EVIDENCE_INCONCLUSIVE', 'FURTHER_REVIEW_REQUIRED'] as const
export type FindingCode = (typeof findingCodes)[number]

// D16 — the A8.1 basis codes an INTAKE_BASIS link carries, copied from the parent intake and verified by the database.
export const intakeBasisCodes = ['UNLINKED_FROZEN_SUBMISSION', 'ASSESSMENT_CASE_ORGANIZATION_MISMATCH', 'ASSESSMENT_CASE_DIGEST_MISMATCH', 'ASSESSMENT_REVIEW_REQUIRED'] as const

// D19 — the derived investigation view. There is no RESOLVED, COMPLETE or CLOSED state.
export const investigationCodes = ['NOT_STARTED', 'EVIDENCE_LINKED', 'FINDING_RECORDED'] as const
export type InvestigationCode = (typeof investigationCodes)[number]

// D20/D21 — the permission the acting assignee's membership must carry, beside A8.2's own assignee permission.
export const INVESTIGATOR_PERMISSION = 'exceptionInvestigation.record'

// §5 — the only accepted requests: one event code and exactly its own controlled attributes. The basis code, the
// actor, the membership, the sequence and the time are the server's.
export type InvestigationEventRequest =
  | { eventCode: 'LINK_EVIDENCE_REFERENCE'; evidenceKind: EvidenceKind; evidenceRecordId: string; evidenceContractVersion: string }
  | { eventCode: 'RECORD_FINDING'; linkedEvidenceEventId: string; findingCode: FindingCode }

// One event's controlled content, exactly as stored (strings: an unexpected stored value must reach the reducer and
// be refused there, not be hidden by a type).
export type InvestigationEventShape = {
  eventCode: string
  evidenceKind: string | null
  evidenceRecordId: string | null
  evidenceContractVersion: string | null
  evidenceBasisCode: string | null
  linkedEvidenceEventId: string | null
  findingCode: string | null
}

// One stored event as the reducer reads it.
export type InvestigationEventFacts = InvestigationEventShape & {
  id: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
}

// The parent intake every event must belong to.
export type InvestigationParent = { exceptionIntakeId: string; organizationId: string; claimId: string }

export type EvidenceLink = { investigationEventId: string; sequence: number; evidenceKind: EvidenceKind; evidenceRecordId: string; evidenceContractVersion: string; evidenceBasisCode: string | null }
export type FindingRecord = { investigationEventId: string; sequence: number; findingCode: FindingCode; linkedEvidenceEventId: string }

// The derived investigation after zero or more events.
export type InvestigationState = {
  investigationCode: InvestigationCode
  links: EvidenceLink[]
  findings: FindingRecord[]
  lastSequence: number
}

// An event whose commit outcome is unknown, exactly as the transaction attempted it, and what the committed history
// holds at its number (as accepted for A8.2, D12).
export type AttemptedInvestigationEvent = InvestigationEventShape & { sequence: number; recordedByMembershipId: string; recordedByUserId: string }
export type ReconciledOutcome = { outcome: 'RECORDED'; investigationEventId: string } | { outcome: 'OTHER_EVENT' } | { outcome: 'NOT_RECORDED' }

export type TransitionResult = { ok: true; state: InvestigationState } | { ok: false; detail: string }
export type DerivationResult = { ok: true; value: InvestigationState } | { ok: false; detail: string }

// §5/§6 — the bounded DTOs: identifiers, controlled codes, the acting membership and user, and database time. No PHI,
// payload, source bytes, amount, currency, payer, narrative, attachment, remediation or resolution.
export type InvestigationEventDto = {
  investigationEventId: string
  contractVersion: string
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  sequence: number
  eventCode: InvestigationEventCode
  evidenceKind: EvidenceKind | null
  evidenceRecordId: string | null
  evidenceContractVersion: string | null
  evidenceBasisCode: string | null
  linkedEvidenceEventId: string | null
  findingCode: FindingCode | null
  recordedByMembershipId: string
  recordedByUserId: string
  recordedAt: string
}

export type InvestigationHistoryDto = { contractVersion: string; exceptionIntakeId: string; items: InvestigationEventDto[]; evaluatedAt: string }

export type InvestigationSummaryDto = {
  contractVersion: string
  exceptionIntakeId: string
  investigationCode: InvestigationCode
  evidenceLinks: EvidenceLink[]
  findings: FindingRecord[]
  // The finding with the highest sequence, or null: the latest recorded observation, never a resolution.
  latestFinding: FindingRecord | null
  eventCount: number
  lastSequence: number | null
  evaluatedAt: string
}

// §6 — refusals: malformed input (400), a missing or foreign Claim, intake or evidence record (404), an actor who is
// not the current, eligible A8.2 assignee (409), an event that is not a legal next step (409), and a busy,
// conflicting, refused or unknown write or an inconsistent stored history (409).
export type InvestigationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE' | 'EXCEPTION_INVESTIGATION_TRANSITION_REFUSED' | 'EXCEPTION_INVESTIGATION_CONFLICT'

export type InvestigationResult<T> = { ok: true; value: T } | { ok: false; code: InvestigationErrorCode; message: string }
