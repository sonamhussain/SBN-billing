// A7.5 — a closure-prerequisite assessment is the immutable, case-level statement of WHY the prerequisites of any
// later financial closure are absent for ONE exact A7.4 case snapshot. It is never an adjudication, payment, posting,
// reconciliation, balance, settlement or closure, and never a payer verdict, a current pointer or a latest choice.
// No positive "ready for closure" result exists: every code below is a missing prerequisite.

export const PREREQ_CONTRACT_VERSION = 'A7-CLOSURE-PREREQ-1'
// The only upstream contracts an assessment reads; any other is a provenance conflict, never guessed.
export const PREREQ_CASE_CONTRACT = 'A7-REVENUE-CASE-1'
export const PREREQ_READINESS_CONTRACT = 'A7-ADJ-READINESS-1'

export const assessmentCodes = ['NO_SOURCE_BASIS', 'INCOMPLETE_SOURCE_CHAIN', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'REVIEW_REQUIRED', 'UNSUPPORTED_SOURCE_BASIS'] as const
export type AssessmentCode = (typeof assessmentCodes)[number]

export const basisCodes = ['NO_REGISTERED_SOURCES', 'SOURCE_LINKS_INCOMPLETE', 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', 'EVIDENCE_REVIEW_REQUIRED', 'UNSUPPORTED_EVIDENCE'] as const
export type BasisCode = (typeof basisCodes)[number]

// §4 — each outcome has exactly one basis.
export const BASIS_OF: Record<AssessmentCode, BasisCode> = {
  NO_SOURCE_BASIS: 'NO_REGISTERED_SOURCES',
  INCOMPLETE_SOURCE_CHAIN: 'SOURCE_LINKS_INCOMPLETE',
  EXTERNAL_FINANCIAL_EVIDENCE_ABSENT: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED',
  REVIEW_REQUIRED: 'EVIDENCE_REVIEW_REQUIRED',
  UNSUPPORTED_SOURCE_BASIS: 'UNSUPPORTED_EVIDENCE',
}

export type Prerequisite = { assessmentCode: AssessmentCode; basisCode: BasisCode }

// The stored A7.4 header, its recorded items and the stored A7.3 readiness of every linked item, exactly as the
// owners returned them (strings: a forged or future value must reach the reducer to be refused, not be rejected by a
// type).
export type CaseHeaderFacts = {
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
}
export type CaseItemFacts = { ordinal: number; sourceEvidenceId: string; classificationId: string | null; readinessId: string | null; itemReasonCode: string }
export type ReadinessFacts = { readinessId: string; classificationId: string; sourceEvidenceId: string; contractVersion: string; readinessCode: string; reasonCode: string }

// A case that contradicts the A7.4 contract is a provenance conflict: no assessment is ever recorded for it.
export type DerivationResult = { ok: true; value: Prerequisite } | { ok: false; refusal: 'PROVENANCE_CONFLICT'; detail: string }

// §6 — the bounded DTO: identifiers, the contract, the two controlled codes, the copied case digest, actor and
// database time. No PHI, payer content, amount, status, balance, source reference, canonical bytes or fingerprint.
export type AssessmentDto = {
  assessmentId: string
  caseId: string
  contractVersion: string
  assessmentCode: AssessmentCode
  basisCode: BasisCode
  caseManifestSha256: string
  recordedByUserId: string
  recordedAt: string
}

// A case's assessments in database-recorded order (then id, for a stable presentation only).
export type AssessmentListDto = { items: AssessmentDto[] }

// A successful POST: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new assessment
// (HTTP 201). The body is identical either way.
export type AssessmentOutcome = { replayed: boolean; assessment: AssessmentDto }

// §6 — refusals: a contradictory or broken case is a PROVENANCE conflict (409, nothing written); a concurrency
// problem or an unknown outcome is a CONFLICT (409).
export type AssessmentErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT' | 'EVIDENCE_CASE_PREREQUISITE_CONFLICT'

export type AssessmentResult<T> = { ok: true; value: T } | { ok: false; code: AssessmentErrorCode; message: string }
