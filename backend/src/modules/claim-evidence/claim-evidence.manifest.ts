import type { CanonicalClaimPayloadV1 } from '../claim-payload/claim-payload.types.ts'
import { sha256Hex } from './claim-evidence.hash.ts'
import {
  EVIDENCE_MANIFEST_VERSION,
  evidenceReferenceKinds,
  evidenceRoleOf,
  versionedEvidenceKinds,
  type EvidenceEntryV1,
  type EvidenceManifestV1,
  type EvidenceReference,
  type EvidenceReferenceKind,
  type FreezeIdentity,
  type OwnerVersionFacts,
} from './claim-evidence.types.ts'

// A6.7 §4 — the one deterministic A6-EVIDENCE-1 manifest builder and encoder.
//
// * The references are exactly those legitimately present in the approved A6.6 payload: its validation
//   run, readiness assessment and findings, its line and diagnosis sources, its A5.9 handoff references,
//   its pricing run and line results, its draft assessment and its approval. Nothing is added because its
//   kind exists, and no newer version is ever substituted.
// * A versioned reference names its owner's parent as reference id and the exact version row; only an
//   evidence artifact version carries a content hash, and only the owner's own 64-character SHA-256.
// * Order: kind rank, then reference id, then reference version id (absent first) — byte order of the
//   lowercase UUID text, which is also PostgreSQL's uuid order. Exact duplicates collapse; nothing else does.
// * Encoding follows the A6.6 rules: fixed key order, explicit nulls, compact UTF-8 JSON, no BOM, no
//   whitespace, no trailing newline. The digest is taken over exactly those bytes.
// Nothing here reads a clock, the locale, the time zone, the environment or the database.

export class EvidenceIncompleteError extends Error {
  readonly referenceKind: EvidenceReferenceKind
  constructor(referenceKind: EvidenceReferenceKind, message: string) {
    super(message)
    this.referenceKind = referenceKind
  }
}

export class ManifestEncodingError extends Error {
  readonly path: string
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.path = path
  }
}

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hex64Shape = /^[0-9a-f]{64}$/

const rankOf = new Map<string, number>(evidenceReferenceKinds.map((kind, index) => [kind, index + 1]))
const isVersioned = (kind: EvidenceReferenceKind) => versionedEvidenceKinds.includes(kind)

const plain = (referenceKind: EvidenceReferenceKind, referenceId: string): EvidenceReference => ({ referenceKind, referenceId, referenceVersionId: null, contentHash: null })

function versioned(referenceKind: EvidenceReferenceKind, versionId: string, parentOf: ReadonlyMap<string, string>): EvidenceReference {
  const parent = parentOf.get(versionId)
  if (parent === undefined) throw new EvidenceIncompleteError(referenceKind, `the exact historical ${referenceKind} cannot be referenced`)
  return { referenceKind, referenceId: parent, referenceVersionId: versionId, contentHash: null }
}

// The references of one approved payload, with the owners' parent ids and hashes for the versioned kinds.
export function evidenceReferencesFromPayload(payload: CanonicalClaimPayloadV1, owners: OwnerVersionFacts): EvidenceReference[] {
  const { header, evidence } = payload
  return [
    plain('VALIDATION_RUN', header.assessedValidationRunId),
    plain('READINESS_ASSESSMENT', header.readinessAssessmentId),
    ...evidence.validationFindingIds.map((id) => plain('VALIDATION_FINDING', id)),
    ...payload.lines.map((line) => plain('ENCOUNTER_ACTIVITY', line.encounterActivityId)),
    ...payload.diagnoses.map((diagnosis) => plain('ENCOUNTER_DIAGNOSIS', diagnosis.encounterDiagnosisId)),
    ...evidence.eligibilityVerificationIds.map((id) => plain('ELIGIBILITY_VERIFICATION', id)),
    ...evidence.priorAuthorizationVersionIds.map((id) => versioned('PRIOR_AUTHORIZATION_VERSION', id, owners.priorAuthorizationOfVersion)),
    ...evidence.authorizationLineIds.map((id) => plain('AUTHORIZATION_LINE', id)),
    ...evidence.evidenceRequirementIds.map((id) => plain('EVIDENCE_REQUIREMENT', id)),
    ...evidence.evidenceArtifactVersionIds.map((id): EvidenceReference => {
      const artifact = owners.evidenceArtifactOfVersion.get(id)
      if (artifact === undefined) throw new EvidenceIncompleteError('EVIDENCE_ARTIFACT_VERSION', 'the exact historical EVIDENCE_ARTIFACT_VERSION cannot be referenced')
      // The owner stores a lowercase SHA-256; anything else is not a hash this package can stand behind.
      if (!hex64Shape.test(artifact.contentHash))
        throw new EvidenceIncompleteError('EVIDENCE_ARTIFACT_VERSION', 'an evidence artifact version has no SHA-256 content hash from its owner')
      return { referenceKind: 'EVIDENCE_ARTIFACT_VERSION', referenceId: artifact.evidenceArtifactId, referenceVersionId: id, contentHash: artifact.contentHash }
    }),
    ...evidence.ruleVersionIds.map((id) => versioned('RULE_VERSION', id, owners.ruleOfVersion)),
    ...evidence.governingSourceVersionIds.map((id) => versioned('RULE_SOURCE_VERSION', id, owners.sourceOfVersion)),
    ...evidence.referenceDatasetVersionIds.map((id) => versioned('REFERENCE_DATASET_VERSION', id, owners.datasetOfVersion)),
    plain('PRICING_RUN', header.pricingRunId),
    ...payload.lines.map((line) => plain('PRICING_LINE_RESULT', line.pricingLineResultId)),
    plain('DRAFT_ASSESSMENT', header.draftAssessmentId),
    plain('REVIEW_EVENT', header.approvalDecisionId),
  ]
}

const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function compareEvidenceReferences(a: EvidenceReference, b: EvidenceReference): number {
  return (
    (rankOf.get(a.referenceKind) as number) - (rankOf.get(b.referenceKind) as number) ||
    textOrder(a.referenceId, b.referenceId) ||
    textOrder(a.referenceVersionId ?? '', b.referenceVersionId ?? '')
  )
}

// The ordered manifest of a freeze. Exact duplicates collapse; the same reference with a different hash is
// an integrity contradiction and is refused.
export function buildEvidenceManifest(identity: FreezeIdentity, payloadSha256: string, references: readonly EvidenceReference[]): EvidenceManifestV1 {
  const ordered = [...references].sort(compareEvidenceReferences)
  const unique: EvidenceReference[] = []
  for (const reference of ordered) {
    const previous = unique.at(-1)
    if (previous && compareEvidenceReferences(previous, reference) === 0) {
      if (previous.contentHash !== reference.contentHash) throw new ManifestEncodingError('$.entries', `the same ${reference.referenceKind} carries two different content hashes`)
      continue
    }
    unique.push(reference)
  }
  return {
    schemaVersion: EVIDENCE_MANIFEST_VERSION,
    claimId: identity.claimId,
    draftAssessmentId: identity.draftAssessmentId,
    approvalReviewEventId: identity.approvalReviewEventId,
    pricingRunId: identity.pricingRunId,
    payloadSha256,
    entries: unique.map((reference, index) => ({ ordinal: index + 1, ...reference, evidenceRole: evidenceRoleOf[reference.referenceKind] })),
  }
}

// ---- the strict encoder ----------------------------------------------------------------------------------

const manifestKeys = ['schemaVersion', 'claimId', 'draftAssessmentId', 'approvalReviewEventId', 'pricingRunId', 'payloadSha256', 'entries'] as const
const entryKeys = ['ordinal', 'referenceKind', 'referenceId', 'referenceVersionId', 'contentHash', 'evidenceRole'] as const

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function requireKeys(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ManifestEncodingError(path, 'must be a plain object')
  const actual = Object.keys(value)
  const unknown = actual.filter((key) => !keys.includes(key))
  if (unknown.length > 0) throw new ManifestEncodingError(path, `unknown key(s): ${unknown.join(', ')}`)
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined)
  if (missing.length > 0) throw new ManifestEncodingError(path, `missing key(s): ${missing.join(', ')}`)
  return value
}

function uuidText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !uuidShape.test(value)) throw new ManifestEncodingError(path, 'must be a lowercase UUID')
  return JSON.stringify(value)
}

function hexText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !hex64Shape.test(value)) throw new ManifestEncodingError(path, 'must be a lowercase SHA-256 hex digest')
  return JSON.stringify(value)
}

function encodeEntry(value: unknown, index: number): { text: string; reference: EvidenceReference } {
  const path = `$.entries[${index}]`
  const entry = requireKeys(value, entryKeys, path)
  if (entry.ordinal !== index + 1) throw new ManifestEncodingError(`${path}.ordinal`, `must be ${index + 1} (ordinals 1..N in order)`)
  const kind = entry.referenceKind
  if (typeof kind !== 'string' || !rankOf.has(kind)) throw new ManifestEncodingError(`${path}.referenceKind`, 'is not an A6-EVIDENCE-1 kind')
  const referenceKind = kind as EvidenceReferenceKind
  if (entry.evidenceRole !== evidenceRoleOf[referenceKind]) throw new ManifestEncodingError(`${path}.evidenceRole`, `must be ${evidenceRoleOf[referenceKind]}`)
  if (isVersioned(referenceKind) === (entry.referenceVersionId === null))
    throw new ManifestEncodingError(`${path}.referenceVersionId`, isVersioned(referenceKind) ? 'is required for a versioned kind' : 'must be null for this kind')
  if ((referenceKind === 'EVIDENCE_ARTIFACT_VERSION') === (entry.contentHash === null))
    throw new ManifestEncodingError(`${path}.contentHash`, referenceKind === 'EVIDENCE_ARTIFACT_VERSION' ? 'is required for an evidence artifact version' : 'must be null for this kind')
  const parts = [
    `"ordinal":${index + 1}`,
    `"referenceKind":${JSON.stringify(referenceKind)}`,
    `"referenceId":${uuidText(entry.referenceId, `${path}.referenceId`)}`,
    `"referenceVersionId":${entry.referenceVersionId === null ? 'null' : uuidText(entry.referenceVersionId, `${path}.referenceVersionId`)}`,
    `"contentHash":${entry.contentHash === null ? 'null' : hexText(entry.contentHash, `${path}.contentHash`)}`,
    `"evidenceRole":${JSON.stringify(entry.evidenceRole)}`,
  ]
  return {
    text: `{${parts.join(',')}}`,
    reference: { referenceKind, referenceId: entry.referenceId as string, referenceVersionId: entry.referenceVersionId as string | null, contentHash: entry.contentHash as string | null },
  }
}

export type EncodedManifest = { text: string; bytes: Buffer; sha256: string }

export function encodeEvidenceManifest(manifest: EvidenceManifestV1): EncodedManifest {
  const value = requireKeys(manifest, manifestKeys, '$')
  if (value.schemaVersion !== EVIDENCE_MANIFEST_VERSION) throw new ManifestEncodingError('$.schemaVersion', `must be ${EVIDENCE_MANIFEST_VERSION}`)
  if (!Array.isArray(value.entries)) throw new ManifestEncodingError('$.entries', 'must be an array')
  const entries = value.entries.map((entry, index) => encodeEntry(entry, index))
  for (let i = 1; i < entries.length; i += 1)
    if (compareEvidenceReferences(entries[i - 1].reference, entries[i].reference) >= 0)
      throw new ManifestEncodingError(`$.entries[${i}]`, 'must be strictly after the previous entry (kind, reference id, version id)')
  const text =
    `{"schemaVersion":${JSON.stringify(EVIDENCE_MANIFEST_VERSION)}` +
    `,"claimId":${uuidText(value.claimId, '$.claimId')}` +
    `,"draftAssessmentId":${uuidText(value.draftAssessmentId, '$.draftAssessmentId')}` +
    `,"approvalReviewEventId":${uuidText(value.approvalReviewEventId, '$.approvalReviewEventId')}` +
    `,"pricingRunId":${uuidText(value.pricingRunId, '$.pricingRunId')}` +
    `,"payloadSha256":${hexText(value.payloadSha256, '$.payloadSha256')}` +
    `,"entries":[${entries.map((entry) => entry.text).join(',')}]}`
  const bytes = Buffer.from(text, 'utf8')
  return { text, bytes, sha256: sha256Hex(bytes) }
}
