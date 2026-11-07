import type { DecisionCode, SubjectKind } from '../coding-release/coding-release.types.ts'

// CRG-01 FINAL Checkpoint B — versioned coding validation (design freeze revision 1.2). CRG owns three append-only
// records: the validator selection per (jurisdiction, authority) (CRG-VALSCOPE-1), and one receipt per required coding
// target of an A5-VAL-2 run plus that run's manifest (CRG-RECEIPT-1). Regulatory compliance remains NOT ESTABLISHED:
// only SYNTHETIC scopes exist in Checkpoint B, and nothing here activates a real catalogue.

export const VALSCOPE_CONTRACT_VERSION = 'CRG-VALSCOPE-1'
export const RECEIPT_CONTRACT_VERSION = 'CRG-RECEIPT-1'
export const VALIDATOR_V1 = 'A5-VAL-1'
export const VALIDATOR_V2 = 'A5-VAL-2'

export const scopeClasses = ['SYNTHETIC', 'REGULATORY'] as const
export type ScopeClass = (typeof scopeClasses)[number]
export const scopeStatuses = ['ENABLED', 'DISABLED', 'SUSPENDED'] as const
export type ScopeStatus = (typeof scopeStatuses)[number]

// The server's selection for a new run: never chosen by a request (CRG-079).
export type ValidatorSelection = { validatorVersion: typeof VALIDATOR_V1 | typeof VALIDATOR_V2 } | { suspended: true }

// §5 — the A5-VAL-2 coding-release findings: one per required target, in the CODING layer, frozen here once.
export const codingReleaseFindings = {
  APPLICABLE: { findingCode: 'CODING_RELEASE_APPLICABLE', outcome: 'PASS', message: 'The code is a member of the one approved coding release that governs its service date.' },
  CODE_NOT_IN_RELEASE: { findingCode: 'CODING_RELEASE_CODE_NOT_IN_RELEASE', outcome: 'FAIL', message: 'The code is not a member of the coding release that governs its service date.' },
  NO_APPROVED_RELEASE: { findingCode: 'CODING_RELEASE_NO_APPROVED_RELEASE', outcome: 'FAIL', message: 'No approved coding release governs this code on its service date.' },
  CONFLICTING_RELEASES: { findingCode: 'CODING_RELEASE_CONFLICTING', outcome: 'FAIL', message: 'More than one approved coding release governs this code on its service date; none is chosen.' },
  RELEASE_NOT_AUTHORIZED: { findingCode: 'CODING_RELEASE_NOT_AUTHORIZED', outcome: 'FAIL', message: 'The coding release that would govern this code is not authorized for use.' },
  AMBIGUOUS_CODE_SYSTEM: { findingCode: 'CODING_RELEASE_AMBIGUOUS_CODE_SYSTEM', outcome: 'FAIL', message: 'The code system of this code cannot be established without guessing.' },
} as const satisfies Record<DecisionCode, { findingCode: string; outcome: 'PASS' | 'FAIL'; message: string }>

// One receipt as planned before its finding row exists (the finding id is bound after A5.7 records the run).
export type ReceiptPlan = {
  subjectKind: SubjectKind
  targetId: string
  masterCodeId: string
  codeSystem: string | null
  canonicalCode: string | null
  decisionCode: DecisionCode
  codeSystemDatasetId: string | null
  releaseImportId: string | null
  referenceDatasetVersionId: string | null
  membershipId: string | null
  sourceRowSha256: string | null
  releaseContentHash: string | null
  membershipFingerprintSha256: string | null
  serviceDate: string
  jurisdictionCode: string
  authorityCode: string
}

// The canonical manifest fields of one receipt (CRG-RECEIPT-1), the same in the database guard and here.
export type ManifestReceipt = {
  subjectKind: string
  targetId: string
  validationFindingId: string
  masterCodeId: string
  codeSystem: string | null
  canonicalCode: string | null
  decisionCode: string
  codeSystemDatasetId: string | null
  releaseImportId: string | null
  referenceDatasetVersionId: string | null
  membershipId: string | null
  sourceRowSha256: string | null
}

// The receipt DTO: identifiers and controlled codes only; the code value stays in its A2 owner and the receipt row.
export type CodingReceiptDto = {
  receiptId: string
  subjectKind: string
  targetId: string
  findingId: string
  masterCodeId: string
  decisionCode: string
  codeSystem: string | null
  codeSystemDatasetId: string | null
  releaseImportId: string | null
  referenceDatasetVersionId: string | null
  membershipId: string | null
}

export type CodingReceiptManifestDto = { manifestId: string; manifestSha256: string; receiptCount: number; receipts: CodingReceiptDto[] }

export const verificationStatuses = ['VERIFIED_AS_RECORDED', 'LEGACY_PROVENANCE_UNVERIFIED'] as const
export type VerificationStatus = (typeof verificationStatuses)[number]

export type RunCodingReceiptsDto = {
  contractVersion: typeof RECEIPT_CONTRACT_VERSION
  validationRunId: string
  validatorVersion: string
  verificationStatus: VerificationStatus
  manifest: CodingReceiptManifestDto | null
  evaluatedAt: string
}

export type SubmissionCodingProvenanceDto = {
  contractVersion: typeof RECEIPT_CONTRACT_VERSION
  submissionId: string
  submissionContractVersion: string
  verificationStatus: VerificationStatus
  validationRunId: string | null
  manifest: CodingReceiptManifestDto | null
  payloadSha256: string
  evaluatedAt: string
}

export type CodingValidationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CODING_RECEIPT_INTEGRITY_CONFLICT'
export type CodingValidationResult<T> = { ok: true; value: T } | { ok: false; code: CodingValidationErrorCode; message: string }
