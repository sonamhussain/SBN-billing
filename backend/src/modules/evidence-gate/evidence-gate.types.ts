// A7.3 — an internal readiness result answers one question about one exact A7.2 classification: has trusted payer
// adjudication evidence been established? Today every source is synthetic, so it never has. A result is never an
// insurer adjudication, payer response, denial, allowance, cash receipt, settlement or claim status; future
// trusted evidence stays blocked until an authorized A9 source owner and a later contract revision exist.

export const READINESS_CONTRACT_VERSION = 'A7-ADJ-READINESS-1'
// The only A7.2 contract this gate reads; any other classification is a provenance conflict, never guessed.
export const SUPPORTED_CLASSIFICATION_CONTRACT = 'A7-EVIDENCE-CLASS-1'

// §3 — the storable readiness codes. No ready, adjudicated, paid, allowed, denied, settled, remitted or balance code
// exists; CONFLICT is never stored (it is a 409).
export const readinessCodes = ['NOT_READY_FOR_ADJUDICATION', 'SOURCE_REQUIRES_REVIEW', 'SOURCE_UNSUPPORTED'] as const
export type ReadinessCode = (typeof readinessCodes)[number]

export const readinessReasonCodes = ['EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_REVIEW_REQUIRED', 'CLASSIFICATION_UNSUPPORTED'] as const
export type ReadinessReasonCode = (typeof readinessReasonCodes)[number]

export type Readiness = { readinessCode: ReadinessCode; reasonCode: ReadinessReasonCode }

// The stored A7.2 facts the reducer reads, exactly as recorded (strings: a forged or future value must reach the
// reducer to be refused, not be rejected by a type).
export type ClassificationFacts = {
  contractVersion: string | null
  classificationCode: string | null
  normalizationOutcome: string | null
  reasonCode: string | null
  sourceFingerprintSha256: string | null
}

// A classification that is not one of the controlled A7-EVIDENCE-CLASS-1 results is a provenance conflict: no
// result is ever recorded for it.
export type ReducerResult = { ok: true; value: Readiness } | { ok: false; refusal: 'PROVENANCE_CONFLICT' }

// §6 — the bounded DTO: identifiers, the contract, the controlled codes, actor and database time. No fingerprint,
// PHI, payer content, amount, status, date of service or raw evidence.
export type ReadinessDto = {
  readinessId: string
  classificationId: string
  sourceEvidenceId: string
  contractVersion: string
  readinessCode: ReadinessCode
  reasonCode: ReadinessReasonCode
  recordedByUserId: string
  recordedAt: string
}

// A classification's results in database-recorded order (then id, for a stable presentation only).
export type ReadinessListDto = { items: ReadinessDto[] }

// A successful POST: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new result (HTTP
// 201). The body is identical either way.
export type ReadinessOutcome = { replayed: boolean; readiness: ReadinessDto }

// §6 — refusals: contradictory or impossible upstream facts are a PROVENANCE conflict (409, nothing written); a
// concurrency problem or an unknown outcome is a CONFLICT (409).
export type ReadinessErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'ADJUDICATION_READINESS_PROVENANCE_CONFLICT' | 'ADJUDICATION_READINESS_CONFLICT'

export type ReadinessResult<T> = { ok: true; value: T } | { ok: false; code: ReadinessErrorCode; message: string }
