// A7.2 — a classification answers one question: what kind of internal evidence did A7.1 register, and can it be
// normalized without ambiguity? It never declares payer adjudication, allowance, denial, payment, contractual
// adjustment or a collectible receivable, and never promotes a source to external truth. A7.3+ may consume it as
// an input under its own authorization; A9 owns any genuine transport or import.

export const CLASSIFICATION_CONTRACT_VERSION = 'A7-EVIDENCE-CLASS-1'
// The A7.1 source contract this classifier understands; any other is UNSUPPORTED, never guessed.
export const SUPPORTED_SOURCE_CONTRACT = 'A7-REVENUE-SOURCE-1'
export const SOURCE_KIND_INTERNAL_SYNTHETIC = 'INTERNAL_SYNTHETIC'
// A7.1 refuses this kind in its API and database; a claim of verification is refused here too (fail closed).
export const SOURCE_KIND_EXTERNAL_VERIFIED = 'EXTERNAL_VERIFIED'
// Reserved: a declared but unverified external source kind. A7.1 cannot register it today (its CHECK allows
// INTERNAL_SYNTHETIC only); the classifier still handles it deterministically if a later owner adds it.
export const DECLARED_EXTERNAL_SOURCE_KINDS = ['EXTERNAL_DECLARED'] as const

export const classificationCodes = ['INTERNAL_DECLARATION', 'EXTERNAL_SOURCE_UNVERIFIED', 'EXTERNAL_SOURCE_VERIFIED', 'INSUFFICIENT_CONTEXT', 'UNSUPPORTED_SOURCE'] as const
export type ClassificationCode = (typeof classificationCodes)[number]

export const normalizationOutcomes = ['CLASSIFIED', 'NEEDS_REVIEW', 'UNSUPPORTED'] as const
export type NormalizationOutcome = (typeof normalizationOutcomes)[number]

export const classificationReasonCodes = [
  'SYNTHETIC_INTERNAL_SOURCE',
  'EXTERNAL_PROOF_ABSENT',
  'SOURCE_CONTEXT_MISSING',
  'SOURCE_CONTEXT_CONTRADICTORY',
  'SOURCE_KIND_UNSUPPORTED',
  'SOURCE_CONTRACT_UNSUPPORTED',
] as const
export type ClassificationReasonCode = (typeof classificationReasonCodes)[number]

// The permitted A7.1 facts the classifier reads — identifiers, codes and the database instant only; never PHI,
// raw evidence bytes, payer content or money. Nullable on purpose: absence is a classification input.
export type SourceFacts = {
  sourceEvidenceId: string | null
  organizationId: string | null
  claimSubmissionId: string | null
  submissionOrganizationId: string | null
  sourceKind: string | null
  sourceReference: string | null
  sourceVersion: string | null
  sourceDigestSha256: string | null
  receivedAtMicros: string | null
}

export type Classification = { classificationCode: ClassificationCode; normalizationOutcome: NormalizationOutcome; reasonCode: ClassificationReasonCode }

// A claim of external verification without an authenticated proof is refused: no row is ever written for it.
export type ClassifierResult = { ok: true; value: Classification } | { ok: false; refusal: 'EXTERNAL_VERIFICATION_UNPROVEN' }

// §6 — the bounded DTO: identifiers, the controlled codes, the contract, the source fingerprint, actor and
// database time. No PHI, payer content, amount, status, raw evidence or source reference.
export type EvidenceClassificationDto = {
  classificationId: string
  sourceEvidenceId: string
  contractVersion: string
  classificationCode: ClassificationCode
  normalizationOutcome: NormalizationOutcome
  reasonCode: ClassificationReasonCode
  sourceFingerprintSha256: string
  recordedByUserId: string
  recordedAt: string
}

// A source record's classifications in database-recorded order (then id, for a stable presentation only).
export type EvidenceClassificationListDto = { items: EvidenceClassificationDto[] }

// A successful POST: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new
// classification (HTTP 201). The body is identical either way.
export type EvidenceClassificationOutcome = { replayed: boolean; classification: EvidenceClassificationDto }

// §6 — refusals: a claim of external verification is NOT_ALLOWED (409, nothing written); a stored row that
// disagrees with its re-derivation, a concurrency or integrity problem, or an unknown outcome is CONFLICT (409).
export type EvidenceClassificationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'EVIDENCE_CLASSIFICATION_NOT_ALLOWED' | 'EVIDENCE_CLASSIFICATION_CONFLICT'

export type EvidenceClassificationResult<T> = { ok: true; value: T } | { ok: false; code: EvidenceClassificationErrorCode; message: string }
