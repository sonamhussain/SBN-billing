import type { TimelineFacts } from '../revenue-delta/revenue-delta.types.ts'

// A7.9 — revenue evidence continuity is the read-only, deterministic, chain-wide reconciliation of ONE Claim's accepted
// A7.7 timeline with its accepted A7.8 adjacent deltas, reported as controlled gaps: which frozen submission has no
// recorded A7.4 case, no recorded A7.5 assessment, or which recorded A7.5 outcome it carries. A gap is never a zero
// balance, a negative determination, a payer verdict, a payment, a collection or a closure; no code here means "ready
// for closure". Nothing is stored and no case, assessment, trace, timeline or delta is created.

export const CONTINUITY_CONTRACT_VERSION = 'A7-REVENUE-CONTINUITY-1'

// §3 — a corrupt history is an error (409), never a successful code, so PROVENANCE_CONFLICT has no value here.
// Listed in their fixed priority: zero freezes, one freeze, any unrecorded case, any unassessed case, all recorded.
export const continuityCodes = [
  'NO_FROZEN_SUBMISSION',
  'SINGLE_FREEZE_NO_COMPARISON',
  'HISTORICAL_EVIDENCE_UNRECORDED',
  'HISTORICAL_EVIDENCE_UNASSESSED',
  'HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF',
] as const
export type ContinuityCode = (typeof continuityCodes)[number]

// §3 — the controlled gap vocabulary in its fixed precedence. NO_SOURCE_BASIS (D5, approved) keeps the A7.5 outcome of
// a case recorded with no source precisely visible; the doc's list has no code for it.
export const gapCodes = [
  'CASE_NOT_RECORDED',
  'PREREQUISITE_NOT_RECORDED',
  'NO_SOURCE_BASIS',
  'SOURCE_CHAIN_INCOMPLETE',
  'REVIEW_REQUIRED',
  'UNSUPPORTED_SOURCE',
  'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT',
] as const
export type GapCode = (typeof gapCodes)[number]

// The A7.8 delta exactly as its owner returned it (strings and numbers: a forged or future value must reach the
// reducer to be refused, not be rejected by a type).
export type DeltaPrerequisiteFacts = { assessmentCode: string; basisCode: string }
export type DeltaComparisonFacts = {
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
  evidenceDeltaCode: string
  sourceCountBefore: number | null
  sourceCountAfter: number | null
  classifiedCountBefore: number | null
  classifiedCountAfter: number | null
  readinessCountBefore: number | null
  readinessCountAfter: number | null
  prerequisiteBefore: DeltaPrerequisiteFacts | null
  prerequisiteAfter: DeltaPrerequisiteFacts | null
  predecessorCaseManifestSha256: string | null
  correctedCaseManifestSha256: string | null
}
export type DeltaFacts = { contractVersion: string; claimId: string; baselineCode: string; comparisonCount: number; comparisons: DeltaComparisonFacts[] }
export type { TimelineFacts }

// §3 — one gap per frozen submission, root to tail; every absent reference stays null, never a made-up id.
export type Gap = {
  ordinal: number
  claimSubmissionId: string
  caseId: string | null
  assessmentId: string | null
  gapCode: GapCode
  basisCode: string | null
}

export type Continuity = { continuityCode: ContinuityCode; submissionCount: number; comparisonCount: number; gaps: Gap[] }

// Any disagreement between or inside the owners is a provenance conflict: no partial result is ever returned.
export type ContinuityResult = { ok: true; value: Continuity } | { ok: false; refusal: 'PROVENANCE_CONFLICT'; detail: string }

// §3 — exactly nine keys: no actor, PHI, payer content, amount, status, balance, payload, correction reason,
// disposition or current/latest pointer.
export type ContinuityDto = {
  contractVersion: string
  claimId: string
  evaluatedAt: string
  continuityCode: ContinuityCode
  submissionCount: number
  comparisonCount: number
  gaps: Gap[]
  sourceTimelineContractVersion: string
  sourceDeltaContractVersion: string
}

// §5 — refusals: a malformed id, a query selector or a body (400), a missing or foreign Claim (404), or a corrupt or
// inconsistent history (409).
export type ContinuityErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVENUE_CONTINUITY_PROVENANCE_CONFLICT'

export type ContinuityServiceResult<T> = { ok: true; value: T } | { ok: false; code: ContinuityErrorCode; message: string }
