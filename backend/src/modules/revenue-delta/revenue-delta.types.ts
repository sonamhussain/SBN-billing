import type { AssessmentCode, BasisCode } from '../case-prerequisite/case-prerequisite.types.ts'

// A7.8 — a revenue evidence delta is the read-only, deterministic comparison of the RECORDED evidence summaries of each
// adjacent pair of frozen submissions in one Claim's accepted A6.9 correction chain, exactly as the A7.7 timeline
// lists them. "Changed" means a stored summary field differs — never more money, a payer decision, a payment, a
// collection, a closure or a causal correction. Nothing is stored and no case, assessment or trace is created.

export const DELTA_CONTRACT_VERSION = 'A7-REVENUE-DELTA-1'

// A corrupt history is an error (409), never a successful delta, so it has no baseline code here.
export const baselineCodes = ['NO_FROZEN_SUBMISSION', 'SINGLE_FREEZE', 'COMPARABLE_HISTORY'] as const
export type BaselineCode = (typeof baselineCodes)[number]

export const evidenceDeltaCodes = ['BOTH_ABSENT', 'NEW_CASE_RECORDED', 'CASE_NO_LONGER_RECORDED', 'RECORDED_SUMMARY_UNCHANGED', 'RECORDED_SUMMARY_CHANGED'] as const
export type EvidenceDeltaCode = (typeof evidenceDeltaCodes)[number]

// The A7.7 timeline exactly as its owner returned it (strings and numbers: a forged or future value must reach the
// reducer to be refused, not be rejected by a type).
export type TimelineCaseFacts = {
  caseId: string
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
}
export type TimelinePrerequisiteFacts = { assessmentId: string; caseId: string; contractVersion: string; assessmentCode: string; basisCode: string; caseManifestSha256: string }
export type TimelineEntryFacts = {
  ordinal: number
  claimSubmissionId: string
  priorSubmissionId: string | null
  correctionLinkId: string | null
  frozenAt: string
  caseSummaries: TimelineCaseFacts[]
  prerequisiteSummaries: TimelinePrerequisiteFacts[]
}
export type TimelineFacts = { contractVersion: string; claimId: string; chainCode: string; submissions: TimelineEntryFacts[]; historyCount: number }

// §3 — the assessment state on either side of a pair: the recorded outcome and its basis, or null when unassessed.
export type PrerequisiteState = { assessmentCode: AssessmentCode; basisCode: BasisCode }

// §3 — ComparisonV1: one per adjacent pair, root to tail; every absent value stays null, never zero.
export type Comparison = {
  ordinal: number
  predecessorSubmissionId: string
  correctedSubmissionId: string
  correctionLinkId: string
  predecessorFrozenAt: string
  correctedFrozenAt: string
  predecessorCaseId: string | null
  correctedCaseId: string | null
  predecessorAssessmentId: string | null
  correctedAssessmentId: string | null
  evidenceDeltaCode: EvidenceDeltaCode
  sourceCountBefore: number | null
  sourceCountAfter: number | null
  classifiedCountBefore: number | null
  classifiedCountAfter: number | null
  readinessCountBefore: number | null
  readinessCountAfter: number | null
  prerequisiteBefore: PrerequisiteState | null
  prerequisiteAfter: PrerequisiteState | null
  predecessorCaseManifestSha256: string | null
  correctedCaseManifestSha256: string | null
}

export type Delta = { baselineCode: BaselineCode; comparisons: Comparison[] }

// Any disagreement in the timeline is a provenance conflict: no partial delta is ever returned.
export type DeltaResult = { ok: true; value: Delta } | { ok: false; refusal: 'PROVENANCE_CONFLICT'; detail: string }

// §3 — DeltaV1: no actor, PHI, payer content, amount, status, balance, payload, correction reason, disposition or
// current/latest pointer.
export type DeltaDto = {
  contractVersion: string
  claimId: string
  evaluatedAt: string
  baselineCode: BaselineCode
  comparisonCount: number
  comparisons: Comparison[]
}

// §5 — refusals: a malformed id, a query selector or a body (400), a missing or foreign Claim (404), or a corrupt
// history (409).
export type DeltaErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVENUE_DELTA_PROVENANCE_CONFLICT'

export type DeltaServiceResult<T> = { ok: true; value: T } | { ok: false; code: DeltaErrorCode; message: string }
