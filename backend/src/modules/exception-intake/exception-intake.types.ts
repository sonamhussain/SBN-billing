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

// §3/§5 — the owner verdict that alone establishes each admissible (source kind, reason) pair. A reason no accepted
// owner can establish today (SOURCE_REFERENCE_UNAVAILABLE, CONTRACT_VERSION_UNSUPPORTED) is never recorded.
//   REVENUE_TIMELINE + the A7.7 owner refuses the Claim's history (409)          -> PROVENANCE_CONFLICT
//   CLOSURE_PREREQUISITE_ASSESSMENT + the A7.6 owner refuses its trace (409)     -> HISTORICAL_RECORD_INCONSISTENT
//   CLOSURE_PREREQUISITE_ASSESSMENT + the stored A7.5 outcome is REVIEW_REQUIRED -> OPERATOR_REVIEW_REQUIRED
export const ADMISSIBLE_REASONS: Record<SourceKind, readonly ExceptionReasonCode[]> = {
  REVENUE_TIMELINE: ['PROVENANCE_CONFLICT'],
  CLOSURE_PREREQUISITE_ASSESSMENT: ['HISTORICAL_RECORD_INCONSISTENT', 'OPERATOR_REVIEW_REQUIRED'],
}

// The owner facts the basis rule reads, exactly as the owners answered (strings: an unexpected value must reach the
// rule and establish nothing, not be rejected by a type).
export type TimelineVerdict = { kind: 'REVENUE_TIMELINE'; timelineCode: 'OK' | string }
export type AssessmentVerdict = { kind: 'CLOSURE_PREREQUISITE_ASSESSMENT'; traceCode: 'OK' | string; assessmentCode: string }
export type OwnerVerdict = TimelineVerdict | AssessmentVerdict

// §5 — the only accepted request: exactly these four fields (no contextCode in v1).
export type IntakeRequest = { sourceKind: SourceKind; sourceRecordId: string; sourceContractVersion: string; exceptionReasonCode: ExceptionReasonCode }

// §4 — the identity preimage: who, which Claim, which exact source under which contract, and why.
export type IdentityParts = { organizationId: string; claimId: string; sourceKind: string; sourceRecordId: string; sourceContractVersion: string; exceptionReasonCode: string }

// §4 — the bounded DTO: identifiers, controlled codes, an owner-supplied digest or null, actor and database time. No
// PHI, payload, amount, payer, status, assignment, narrative or resolution.
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
