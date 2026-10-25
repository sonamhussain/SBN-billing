import { assessmentCodes, type AssessmentCode, type BasisCode } from '../case-prerequisite/case-prerequisite.types.ts'

// A7.6 — a basis trace is the read-only, deterministic EXPLANATION of one already-recorded A7.5 closure-prerequisite
// assessment: which stored A7.4 case items and stored A7.3 readiness results explain its controlled outcome. It is
// never a new decision, exception, payment finding, financial status or stored record, and never a current or latest
// pointer. Nothing is written to compute it.

export const TRACE_CONTRACT_VERSION = 'A7-CLOSURE-TRACE-1'

// The trace code names the explained outcome in the A7.5 vocabulary itself: a trace never invents an outcome.
export const traceCodes = assessmentCodes
export type TraceCode = AssessmentCode

// One explanation per case item: why that source does not establish a closure prerequisite.
export const explanationCodes = ['SOURCE_UNCLASSIFIED', 'CLASSIFICATION_NO_READINESS', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_REVIEW_REQUIRED', 'CLASSIFICATION_UNSUPPORTED'] as const
export type ExplanationCode = (typeof explanationCodes)[number]

// The owners' stored facts the reducer reads, exactly as they returned them (strings: a forged or future value must
// reach the reducer to be refused, not be rejected by a type).
export type AssessmentFacts = {
  assessmentId: string
  caseId: string
  organizationId: string
  contractVersion: string
  assessmentCode: string
  basisCode: string
  caseManifestSha256: string
}
export type CaseHeaderFacts = {
  caseId: string
  organizationId: string
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
}
export type CaseEntryFacts = { ordinal: number; sourceEvidenceId: string; classificationId: string | null; readinessId: string | null; itemReasonCode: string }
// Every stored A7.3 result of each LINKED entry's classification (all of them, so a duplicate cannot hide).
export type ReadinessFacts = { readinessId: string; classificationId: string; sourceEvidenceId: string; contractVersion: string; readinessCode: string; reasonCode: string }
export type TraceFacts = {
  assessment: AssessmentFacts
  header: CaseHeaderFacts
  entries: CaseEntryFacts[]
  readiness: ReadinessFacts[]
  // The A7.1 registrations of the case's frozen submission (identifiers only): every entry's source must be one.
  submissionSourceIds: string[]
}

// §3 — TraceItemV1: exactly one per stored A7.4 entry, in ordinal order; an absent link stays null.
export type TraceItem = {
  ordinal: number
  sourceEvidenceId: string
  classificationId: string | null
  readinessId: string | null
  sourceReasonCode: string
  readinessCode: string | null
  readinessReasonCode: string | null
  explanationCode: ExplanationCode
}

export type Trace = { traceCode: TraceCode; traceItems: TraceItem[] }

// Any disagreement between the owners' stored facts is a provenance conflict: no trace is ever guessed.
export type TraceResult = { ok: true; value: Trace } | { ok: false; refusal: 'PROVENANCE_CONFLICT'; detail: string }

// §3 — the bounded DTO: identifiers, contracts, the controlled codes, counts, the copied case digest, the item
// explanations and the database evaluation instant. No actor, PHI, payer content, amount, status, balance, source
// reference, per-source fingerprint or canonical bytes.
export type BasisTraceDto = {
  contractVersion: string
  assessmentId: string
  caseId: string
  caseManifestSha256: string
  assessmentCode: AssessmentCode
  basisCode: BasisCode
  sourceCount: number
  itemCount: number
  traceCode: TraceCode
  traceItems: TraceItem[]
  evaluatedAt: string
}

// §6 — refusals: a malformed id (400), a missing or foreign assessment (404), or owners' facts that disagree (409).
export type TraceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CLOSURE_BASIS_PROVENANCE_CONFLICT'

export type TraceServiceResult<T> = { ok: true; value: T } | { ok: false; code: TraceErrorCode; message: string }
