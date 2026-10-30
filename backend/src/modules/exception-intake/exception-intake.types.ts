// A8.1 — an exception intake is the immutable, controlled record that one exact SBN business record carries a
// verified operational exception, established by the record's own accepted owner. It is never a payer verdict, a
// denial, a payment, a balance, a closure, an assignment or a status: it anchors an exception identity for later A8
// owners and changes nothing in the record it names. Absence of external financial evidence is never an exception.

export const EXCEPTION_INTAKE_CONTRACT_VERSION = 'A8-EXCEPTION-INTAKE-1'

// §4 — the versioned, finite set of upstream owners an exception may anchor on, each with the one contract it is
// accepted under. A Claim's revenue timeline is named by its Claim id; an assessment by its own id.
export const sourceKinds = ['REVENUE_TIMELINE', 'CLOSURE_PREREQUISITE_ASSESSMENT'] as const
export type SourceKind = (typeof sourceKinds)[number]

export const SOURCE_CONTRACT_OF: Record<SourceKind, string> = {
  REVENUE_TIMELINE: 'A7-REVENUE-TIMELINE-1',
  CLOSURE_PREREQUISITE_ASSESSMENT: 'A7-CLOSURE-PREREQ-1',
}

// §3 — the controlled reasons. No paid, denied, closed, overpaid or underpaid reason exists.
export const exceptionReasonCodes = ['PROVENANCE_CONFLICT', 'SOURCE_REFERENCE_UNAVAILABLE', 'CONTRACT_VERSION_UNSUPPORTED', 'HISTORICAL_RECORD_INCONSISTENT', 'OPERATOR_REVIEW_REQUIRED'] as const
export type ExceptionReasonCode = (typeof exceptionReasonCodes)[number]

// §3/§5 — the (source kind, reason) pairs an owner can establish. A reason no accepted owner can establish today
// (SOURCE_REFERENCE_UNAVAILABLE, CONTRACT_VERSION_UNSUPPORTED) is never recorded.
export const ADMISSIBLE_REASONS: Record<SourceKind, readonly ExceptionReasonCode[]> = {
  REVENUE_TIMELINE: ['PROVENANCE_CONFLICT'],
  CLOSURE_PREREQUISITE_ASSESSMENT: ['HISTORICAL_RECORD_INCONSISTENT', 'OPERATOR_REVIEW_REQUIRED'],
}

// The controlled basis: the one specific, owner-backed condition that proves a reason. An owner's refusal alone is
// never a basis — its specific underlying condition must hold in the owners' stored facts. Every other refusal
// fails closed.
//   PROVENANCE_CONFLICT            <- UNLINKED_FROZEN_SUBMISSION: the A7.7 owner refuses the Claim's history, the
//                                     Claim has two or more A6.7 freezes, the A6.9 links form one valid chain, and a
//                                     freeze lies outside it (basis record: the latest such freeze)
//   HISTORICAL_RECORD_INCONSISTENT <- ASSESSMENT_CASE_ORGANIZATION_MISMATCH: the A7.6 owner refuses the trace and the
//                                     stored A7.5 assessment's organization is not its A7.4 case's (basis: the case)
//                                  <- ASSESSMENT_CASE_DIGEST_MISMATCH: the A7.6 owner refuses the trace, the two
//                                     organizations agree, and the assessment's stored case digest is not the case's
//                                     stored digest (basis: the case)
//   OPERATOR_REVIEW_REQUIRED       <- ASSESSMENT_REVIEW_REQUIRED: the stored A7.5 outcome is exactly REVIEW_REQUIRED
//                                     (basis: the assessment itself)
export const basisCodes = ['UNLINKED_FROZEN_SUBMISSION', 'ASSESSMENT_CASE_ORGANIZATION_MISMATCH', 'ASSESSMENT_CASE_DIGEST_MISMATCH', 'ASSESSMENT_REVIEW_REQUIRED'] as const
export type BasisCode = (typeof basisCodes)[number]

export const BASES_OF_REASON: Record<ExceptionReasonCode, readonly BasisCode[]> = {
  PROVENANCE_CONFLICT: ['UNLINKED_FROZEN_SUBMISSION'],
  HISTORICAL_RECORD_INCONSISTENT: ['ASSESSMENT_CASE_ORGANIZATION_MISMATCH', 'ASSESSMENT_CASE_DIGEST_MISMATCH'],
  OPERATOR_REVIEW_REQUIRED: ['ASSESSMENT_REVIEW_REQUIRED'],
  SOURCE_REFERENCE_UNAVAILABLE: [],
  CONTRACT_VERSION_UNSUPPORTED: [],
}

// The owner facts the basis rule reads, exactly as the owners answered (strings: an unexpected value must reach the
// rule and establish nothing, not be rejected by a type).
//   timeline: the A7.7 verdict; every A6.7 freeze of the Claim with its database instant in microseconds (A6.9's
//             freeze facts); every A6.9 link of the Claim.
//   assessment: the A7.6 verdict; the stored A7.5 assessment; its A7.4 case's organization and stored digest.
export type FreezeInstant = { submissionId: string; frozenAtMicros: number }
export type LinkEdge = { id: string; priorSubmissionId: string; correctedSubmissionId: string }
export type TimelineVerdict = { kind: 'REVENUE_TIMELINE'; timelineCode: 'OK' | string; freezes: FreezeInstant[]; links: LinkEdge[] }
export type AssessmentVerdict = {
  kind: 'CLOSURE_PREREQUISITE_ASSESSMENT'
  traceCode: 'OK' | string
  assessmentId: string
  assessmentCode: string
  assessmentOrganizationId: string
  assessmentCaseDigest: string
  caseId: string
  caseOrganizationId: string | null
  caseManifestSha256: string | null
}
export type OwnerVerdict = TimelineVerdict | AssessmentVerdict

// The one basis that proves a requested reason, or none (fail closed).
export type EstablishedBasis = { basisCode: BasisCode; basisRecordId: string }

// §5 — the only accepted request: exactly these four fields (no contextCode in v1).
export type IntakeRequest = { sourceKind: SourceKind; sourceRecordId: string; sourceContractVersion: string; exceptionReasonCode: ExceptionReasonCode }

// §4 — the identity preimage: who, which Claim, which exact source under which contract, and why.
export type IdentityParts = { organizationId: string; claimId: string; sourceKind: string; sourceRecordId: string; sourceContractVersion: string; exceptionReasonCode: string }

// §4 — the bounded DTO: identifiers, controlled codes, an owner-supplied digest or null, the controlled basis that
// proved the reason and the owner record it names, actor and database time. No PHI, payload, amount, payer, status,
// assignment, narrative, owner message or resolution.
export type ExceptionIntakeDto = {
  exceptionIntakeId: string
  contractVersion: string
  organizationId: string
  claimId: string
  sourceKind: SourceKind
  sourceRecordId: string
  sourceContractVersion: string
  sourceFingerprintSha256: string | null
  exceptionReasonCode: ExceptionReasonCode
  basisCode: BasisCode
  basisRecordId: string
  identityKey: string
  recordedByUserId: string
  recordedAt: string
}

export type ExceptionIntakeListDto = { items: ExceptionIntakeDto[] }

// A successful POST: `replayed` is true for the exact repeated request (HTTP 200), false for a new record (HTTP 201).
// The body is identical either way.
export type ExceptionIntakeOutcome = { replayed: boolean; intake: ExceptionIntakeDto }

// §5 — refusals: malformed input (400), a missing or foreign Claim or source (404), a reason its owner does not
// establish (409 INTAKE_BASIS_NOT_ESTABLISHED), and a busy, conflicting, refused or unknown write (409).
export type ExceptionIntakeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTAKE_BASIS_NOT_ESTABLISHED' | 'EXCEPTION_INTAKE_CONFLICT'

export type ExceptionIntakeResult<T> = { ok: true; value: T } | { ok: false; code: ExceptionIntakeErrorCode; message: string }
