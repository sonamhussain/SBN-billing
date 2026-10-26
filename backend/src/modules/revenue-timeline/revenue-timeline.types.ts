import type { AssessmentCode, BasisCode } from '../case-prerequisite/case-prerequisite.types.ts'

// A7.7 — a revenue evidence timeline is the read-only, deterministic history of ONE Claim: every frozen submission in
// accepted A6.9 correction-chain order (root to tail), each with only the exact A7.4 cases and A7.5 assessments
// recorded for it. It never selects a current or latest submission, never asserts a payer or financial outcome and
// never stores anything. An absent case or assessment is data ("none recorded"), never a zero balance or a status.

export const TIMELINE_CONTRACT_VERSION = 'A7-REVENUE-TIMELINE-1'

// A contradictory history is an error (409), never a successful timeline, so it has no chain code here.
export const chainCodes = ['NO_FROZEN_SUBMISSION', 'LINEAR_HISTORY'] as const
export type ChainCode = (typeof chainCodes)[number]

// The owners' stored facts the reducer composes, exactly as they returned them (strings: a forged or future value
// must reach the reducer to be refused, not be rejected by a type).
export type FreezeFacts = { submissionId: string; claimId: string; frozenAt: string; frozenAtMicros: number }
// The A6.9 links in the order the A6.9 owner's checked chain returned them.
export type LinkFacts = { correctionLinkId: string; claimId: string; priorSubmissionId: string; correctedSubmissionId: string }
export type CaseFacts = {
  caseId: string
  claimSubmissionId: string
  organizationId: string
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
}
export type AssessmentFacts = { assessmentId: string; caseId: string; organizationId: string; contractVersion: string; assessmentCode: string; basisCode: string; caseManifestSha256: string }
export type TimelineFacts = { claimId: string; organizationId: string; freezes: FreezeFacts[]; links: LinkFacts[]; cases: CaseFacts[]; assessments: AssessmentFacts[] }

// §3 — the bounded summaries: identifiers, contracts, controlled codes, copied counts and digests only.
export type CaseSummary = {
  caseId: string
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
}
export type PrerequisiteSummary = { assessmentId: string; caseId: string; contractVersion: string; assessmentCode: AssessmentCode; basisCode: BasisCode; caseManifestSha256: string }

// §3 — SubmissionEntryV1: one per frozen submission, in chain order; the root has no predecessor and no link.
export type SubmissionEntry = {
  ordinal: number
  claimSubmissionId: string
  priorSubmissionId: string | null
  correctionLinkId: string | null
  frozenAt: string
  caseSummaries: CaseSummary[]
  prerequisiteSummaries: PrerequisiteSummary[]
}

export type Timeline = { chainCode: ChainCode; submissions: SubmissionEntry[] }

// Any disagreement between the owners' stored facts is a provenance conflict: no partial timeline is ever returned.
export type ComposeResult = { ok: true; value: Timeline } | { ok: false; refusal: 'PROVENANCE_CONFLICT'; detail: string }

// §3 — TimelineV1: no actor, PHI, payer content, amount, status, balance, payload, manifest bytes, source reference,
// lifecycle disposition or current/latest pointer.
export type TimelineDto = {
  contractVersion: string
  claimId: string
  evaluatedAt: string
  chainCode: ChainCode
  submissions: SubmissionEntry[]
  historyCount: number
}

// §5 — refusals: a malformed id, a query selector or a body (400), a missing or foreign Claim (404), or owners' facts
// that disagree (409).
export type TimelineErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVENUE_TIMELINE_PROVENANCE_CONFLICT'

export type TimelineServiceResult<T> = { ok: true; value: T } | { ok: false; code: TimelineErrorCode; message: string }
