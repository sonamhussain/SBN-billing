// A6.9 — a correction link answers one question: which immutable A6.7 freeze of a Claim was corrected by
// which later, distinct freeze of the same Claim, why, by whom and when (database time)? It is a historical
// traceability fact only: not an edit, a replacement, an approval, a resubmission or a payer event. Both
// freezes keep their own approval, assessment, pricing, bytes, evidence package and A6.8 lifecycle; a link
// never changes any of them.
//
// One Claim has at most one linear correction chain: every freeze is the prior of at most one link and the
// correction of at most one link, the chain grows only at its tail, and every correction was frozen strictly
// after the freeze it corrects. A9 owns any later send; A7/A8 consume the traceability.

export const CORRECTION_CONTRACT_VERSION = 'A6-CORRECTION-1'

// §4 — the controlled reason vocabulary. INTERNAL_OTHER is a code, never free text.
export const correctionReasonCodes = ['CORRECTED_CODING', 'CORRECTED_SOURCE', 'CORRECTED_PRICING', 'CORRECTED_DOCUMENTATION', 'INTERNAL_OTHER'] as const
export type CorrectionReasonCode = (typeof correctionReasonCodes)[number]

// §7 — the validated request. Claim from the path; actor and instants from the server.
export type CorrectionLinkRequest = {
  priorSubmissionId: string
  correctedSubmissionId: string
  reasonCode: CorrectionReasonCode
}

// §7 — the bounded DTO: identifiers, the controlled reason, actor, database time and contract only. No PHI,
// amount, free text, manifest, digest or bytes.
export type CorrectionLinkDto = {
  correctionLinkId: string
  claimId: string
  priorSubmissionId: string
  correctedSubmissionId: string
  reasonCode: CorrectionReasonCode
  recordedByUserId: string
  recordedAt: string
  contractVersion: string
}

// The Claim's correction chain in chain order (root to tail), derived from the immutable links.
export type CorrectionLinkListDto = { items: CorrectionLinkDto[] }

// A successful POST: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new link
// (HTTP 201). The body is identical either way.
export type CorrectionOutcome = { replayed: boolean; link: CorrectionLinkDto }

// §8 — refusals. A business refusal (fork, join, cycle, chronology, same assessment, reused pair) and an
// integrity or concurrency problem are both a safe 409 with no write.
export type ClaimCorrectionErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CLAIM_CORRECTION_NOT_ALLOWED' | 'CLAIM_CORRECTION_CONFLICT'

export type ClaimCorrectionResult<T> = { ok: true; value: T } | { ok: false; code: ClaimCorrectionErrorCode; message: string }
