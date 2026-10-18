import type { EvidenceManifestV1 } from '../claim-evidence/claim-evidence.types.ts'

// A6.7 — a ClaimSubmission answers one question: which exact approved canonical bytes of ONE Claim were
// frozen, from which A6.4 draft assessment, A6.5 APPROVE and A6.3 pricing run, on which evidence lineage,
// and when (database time)? It is an internal custody record: it is not sent, has no lifecycle state,
// external identifier or acknowledgement, and is not evidence that any outside party received or paid it.
// A6.8 owns lifecycle events; A9 owns external connectivity; A6.9 owns correction and resubmission.
//
// Physical storage: claim_freezes, claim_freeze_evidence_manifests and claim_freeze_evidence_entries (the
// names avoid the accepted A6.1–A6.6 phase guards). The API, contracts, audit and errors keep the
// business name.

export const SUBMISSION_CONTRACT_VERSION = 'A6-SUBMISSION-1'

// §2 — the validated request. The Claim comes from the path; actor, payload, amounts, hashes, sequence,
// state and every instant are the server's.
export type FreezeRequest = {
  draftAssessmentId: string
  approvalDecisionId: string
}

// §6 — bounded metadata: ids, contract versions, digests, the byte length, counts and UTC instants. Never the
// raw payload or manifest bytes, a patient, diagnosis, code text or amount.
export type ClaimSubmissionDto = {
  submissionId: string
  claimId: string
  draftAssessmentId: string
  approvalDecisionId: string
  pricingRunId: string
  submissionContractVersion: string
  payloadSchemaVersion: string
  approvedAssemblyFingerprint: string
  payloadSha256: string
  payloadByteLength: number
  frozenAt: string
  createdByUserId: string
  createdAt: string
  evidencePackage: {
    evidencePackageId: string
    manifestContractVersion: string
    entryCount: number
    manifestSha256: string
    packageSealSha256: string
    createdAt: string
  }
}

export type ClaimSubmissionListDto = { items: ClaimSubmissionDto[] }

// §6 — the typed manifest exactly as frozen (decoded from the stored bytes, never rebuilt from today's rows)
// with its digests. Admin only.
export type EvidenceManifestDto = {
  submissionId: string
  evidencePackageId: string
  manifestContractVersion: string
  entryCount: number
  manifestSha256: string
  packageSealSha256: string
  manifest: EvidenceManifestV1
}

// §6 — the transaction-aware internal read for A6.8/A9: the frozen bytes themselves, never a mutable
// reconstruction.
export type FrozenSubmission = {
  submission: ClaimSubmissionDto
  canonicalPayloadBytes: Buffer
  manifestBytes: Buffer
}

// §6 — refusals.
export type ClaimSubmissionErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CLAIM_SUBMISSION_NOT_APPROVED'
  | 'CLAIM_SUBMISSION_STALE'
  | 'CLAIM_SUBMISSION_EVIDENCE_INCOMPLETE'
  | 'CLAIM_SUBMISSION_CONFLICT'
  | 'CLAIM_SUBMISSION_UNSUPPORTED'

export type ClaimSubmissionResult<T> = { ok: true; value: T } | { ok: false; code: ClaimSubmissionErrorCode; message: string }

// A successful freeze: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new
// freeze (HTTP 201). The body is identical either way.
export type FreezeOutcome = { replayed: boolean; submission: ClaimSubmissionDto }
