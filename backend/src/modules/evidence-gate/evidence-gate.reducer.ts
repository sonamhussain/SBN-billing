import { SUPPORTED_CLASSIFICATION_CONTRACT, type ClassificationFacts, type Readiness, type ReducerResult } from './evidence-gate.types.ts'

// A7.3 §5 — the one pure, deterministic readiness reducer. It reads the STORED A7.2 classification and never
// re-runs the A7.2 classifier or recomputes its fingerprint. No clock, locale, time zone, environment, database,
// network, randomness or money is read: the same facts always give the same result.
//
// Exact combinations only (the ones the A7.2 classifier can produce); anything else is a provenance conflict:
//   INTERNAL_DECLARATION / CLASSIFIED / SYNTHETIC_INTERNAL_SOURCE          -> NOT_READY_FOR_ADJUDICATION
//   EXTERNAL_SOURCE_UNVERIFIED / NEEDS_REVIEW / EXTERNAL_PROOF_ABSENT       -> SOURCE_REQUIRES_REVIEW
//   INSUFFICIENT_CONTEXT / NEEDS_REVIEW / SOURCE_CONTEXT_MISSING            -> SOURCE_REQUIRES_REVIEW
//   INSUFFICIENT_CONTEXT / NEEDS_REVIEW / SOURCE_CONTEXT_CONTRADICTORY      -> SOURCE_REQUIRES_REVIEW
//   UNSUPPORTED_SOURCE / UNSUPPORTED / SOURCE_KIND_UNSUPPORTED              -> SOURCE_UNSUPPORTED
//   UNSUPPORTED_SOURCE / UNSUPPORTED / SOURCE_CONTRACT_UNSUPPORTED          -> SOURCE_UNSUPPORTED
// No positive "ready" result exists: A7.1 admits only INTERNAL_SYNTHETIC and A7.2 refuses external verification.

const NOT_READY: Readiness = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }
const REVIEW: Readiness = { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' }
const UNSUPPORTED: Readiness = { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }

const readinessByClassification = new Map<string, Readiness>([
  ['INTERNAL_DECLARATION|CLASSIFIED|SYNTHETIC_INTERNAL_SOURCE', NOT_READY],
  ['EXTERNAL_SOURCE_UNVERIFIED|NEEDS_REVIEW|EXTERNAL_PROOF_ABSENT', REVIEW],
  ['INSUFFICIENT_CONTEXT|NEEDS_REVIEW|SOURCE_CONTEXT_MISSING', REVIEW],
  ['INSUFFICIENT_CONTEXT|NEEDS_REVIEW|SOURCE_CONTEXT_CONTRADICTORY', REVIEW],
  ['UNSUPPORTED_SOURCE|UNSUPPORTED|SOURCE_KIND_UNSUPPORTED', UNSUPPORTED],
  ['UNSUPPORTED_SOURCE|UNSUPPORTED|SOURCE_CONTRACT_UNSUPPORTED', UNSUPPORTED],
])

const fingerprintShape = /^[0-9a-f]{64}$/
const conflict: ReducerResult = { ok: false, refusal: 'PROVENANCE_CONFLICT' }

export function deriveReadiness(facts: ClassificationFacts): ReducerResult {
  if (facts.contractVersion !== SUPPORTED_CLASSIFICATION_CONTRACT) return conflict
  if (facts.sourceFingerprintSha256 === null || !fingerprintShape.test(facts.sourceFingerprintSha256)) return conflict
  const parts = [facts.classificationCode, facts.normalizationOutcome, facts.reasonCode]
  if (parts.some((part) => part === null || part.includes('|'))) return conflict
  const readiness = readinessByClassification.get(parts.join('|'))
  return readiness ? { ok: true, value: { ...readiness } } : conflict
}

// §5 — a recorded result is the idempotent answer only when it agrees exactly with the derivation from its stored
// classification (readiness, reason, copied fingerprint, source and organization); any difference is a conflict,
// and the recorded row is never rewritten.
export type ReadinessRecordFacts = { readinessCode: string; reasonCode: string; classificationFingerprintSha256: string; sourceEvidenceId: string; organizationId: string }

export function recordedReadinessAgrees(recorded: ReadinessRecordFacts, derived: ReadinessRecordFacts): boolean {
  return (
    recorded.readinessCode === derived.readinessCode &&
    recorded.reasonCode === derived.reasonCode &&
    recorded.classificationFingerprintSha256 === derived.classificationFingerprintSha256 &&
    recorded.sourceEvidenceId === derived.sourceEvidenceId &&
    recorded.organizationId === derived.organizationId
  )
}
