import { createHash } from 'node:crypto'
import {
  CLASSIFICATION_CONTRACT_VERSION,
  DECLARED_EXTERNAL_SOURCE_KINDS,
  SOURCE_KIND_EXTERNAL_VERIFIED,
  SOURCE_KIND_INTERNAL_SYNTHETIC,
  SUPPORTED_SOURCE_CONTRACT,
  type Classification,
  type ClassifierResult,
  type SourceFacts,
} from './evidence-classification.types.ts'

// A7.2 — the one pure, deterministic classifier (§4) and the source fingerprint (§3). No clock, locale,
// time zone, environment, database, network or randomness is read: the same facts always give the same result.
//
// Precedence (first match wins):
// 1. a claim of external verification       -> refused (no authenticated source proof exists)
// 2. a required fact missing                -> INSUFFICIENT_CONTEXT / NEEDS_REVIEW / SOURCE_CONTEXT_MISSING
// 3. contradictory facts                    -> INSUFFICIENT_CONTEXT / NEEDS_REVIEW / SOURCE_CONTEXT_CONTRADICTORY
// 4. an unsupported source contract          -> UNSUPPORTED_SOURCE / UNSUPPORTED / SOURCE_CONTRACT_UNSUPPORTED
// 5. a declared, unverified external source  -> EXTERNAL_SOURCE_UNVERIFIED / NEEDS_REVIEW / EXTERNAL_PROOF_ABSENT
// 6. INTERNAL_SYNTHETIC                      -> INTERNAL_DECLARATION / CLASSIFIED / SYNTHETIC_INTERNAL_SOURCE
// 7. any other kind                          -> UNSUPPORTED_SOURCE / UNSUPPORTED / SOURCE_KIND_UNSUPPORTED
// EXTERNAL_SOURCE_VERIFIED is never produced.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const micros = /^[0-9]{1,20}$/

export function classifySource(facts: SourceFacts): ClassifierResult {
  if (facts.sourceKind === SOURCE_KIND_EXTERNAL_VERIFIED) return { ok: false, refusal: 'EXTERNAL_VERIFICATION_UNPROVEN' }

  const required = [facts.sourceEvidenceId, facts.organizationId, facts.claimSubmissionId, facts.submissionOrganizationId, facts.sourceKind, facts.sourceReference, facts.sourceVersion, facts.receivedAtMicros]
  if (required.some((value) => value === null || value === '')) return { ok: true, value: { classificationCode: 'INSUFFICIENT_CONTEXT', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'SOURCE_CONTEXT_MISSING' } }

  const contradictory =
    facts.organizationId !== facts.submissionOrganizationId ||
    ![facts.sourceEvidenceId, facts.organizationId, facts.claimSubmissionId].every((id) => uuidShape.test(id as string)) ||
    !micros.test(facts.receivedAtMicros as string) ||
    // A7.1 stores no digest: a digest on a source no trusted owner can stand behind contradicts its contract.
    facts.sourceDigestSha256 !== null
  if (contradictory) return { ok: true, value: { classificationCode: 'INSUFFICIENT_CONTEXT', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'SOURCE_CONTEXT_CONTRADICTORY' } }

  if (facts.sourceVersion !== SUPPORTED_SOURCE_CONTRACT) return { ok: true, value: { classificationCode: 'UNSUPPORTED_SOURCE', normalizationOutcome: 'UNSUPPORTED', reasonCode: 'SOURCE_CONTRACT_UNSUPPORTED' } }

  if ((DECLARED_EXTERNAL_SOURCE_KINDS as readonly string[]).includes(facts.sourceKind as string))
    return { ok: true, value: { classificationCode: 'EXTERNAL_SOURCE_UNVERIFIED', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'EXTERNAL_PROOF_ABSENT' } }

  if (facts.sourceKind === SOURCE_KIND_INTERNAL_SYNTHETIC) return { ok: true, value: { classificationCode: 'INTERNAL_DECLARATION', normalizationOutcome: 'CLASSIFIED', reasonCode: 'SYNTHETIC_INTERNAL_SOURCE' } }

  return { ok: true, value: { classificationCode: 'UNSUPPORTED_SOURCE', normalizationOutcome: 'UNSUPPORTED', reasonCode: 'SOURCE_KIND_UNSUPPORTED' } }
}

// §3 — SHA-256 over the canonical source-identifying facts and the classification contract, as UTF-8 text:
//   "SBN-A7-EVIDENCE-CLASS-1\n" then, in this order, one "name=value\n" line each for
//   contract, sourceEvidenceId, sourceKind, sourceReference, sourceVersion, claimSubmissionId, receivedAtMicros.
// The instant is the database's integer microseconds since the epoch (never a JavaScript Date, which would round
// to milliseconds), so PostgreSQL recomputes the identical text in the insert guard. No PHI or raw bytes.
export const FINGERPRINT_DOMAIN = 'SBN-A7-EVIDENCE-CLASS-1\n'

export function sourceFingerprintText(facts: SourceFacts): string {
  const fields: [string, string | null][] = [
    ['contract', CLASSIFICATION_CONTRACT_VERSION],
    ['sourceEvidenceId', facts.sourceEvidenceId],
    ['sourceKind', facts.sourceKind],
    ['sourceReference', facts.sourceReference],
    ['sourceVersion', facts.sourceVersion],
    ['claimSubmissionId', facts.claimSubmissionId],
    ['receivedAtMicros', facts.receivedAtMicros],
  ]
  for (const [name, value] of fields) if (value === null || /[\n=]/.test(value)) throw new Error(`fingerprint field ${name} is missing or not canonical`)
  return FINGERPRINT_DOMAIN + fields.map(([name, value]) => `${name}=${value}\n`).join('')
}

export const sourceFingerprintSha256 = (facts: SourceFacts) => createHash('sha256').update(Buffer.from(sourceFingerprintText(facts), 'utf8')).digest('hex')

// §4 — a recorded classification is the idempotent answer only when it agrees exactly with the re-derivation
// from its source (classification, outcome, reason, fingerprint and organization); any difference is a conflict,
// and the recorded row is never rewritten.
export type ClassificationRecordFacts = { [K in keyof Classification]: string } & { sourceFingerprintSha256: string; organizationId: string }

export function recordedClassificationAgrees(recorded: ClassificationRecordFacts, derived: ClassificationRecordFacts): boolean {
  return (
    recorded.classificationCode === derived.classificationCode &&
    recorded.normalizationOutcome === derived.normalizationOutcome &&
    recorded.reasonCode === derived.reasonCode &&
    recorded.sourceFingerprintSha256 === derived.sourceFingerprintSha256 &&
    recorded.organizationId === derived.organizationId
  )
}
