import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import { ARTIFACT_FORMATS, type ArtifactFormat } from './coding-release.artifact.ts'
import {
  SHA256_HEX,
  codeSystems,
  mappingPurposes,
  retirementClassifications,
  rightsStatuses,
  type CodeSystem,
  type MappingPurpose,
  type RetirementClassification,
  type RightsStatus,
} from './coding-release.types.ts'

// CRG-01 FINAL Checkpoint A — strict inputs. The read takes only the encounter id: any query parameter or body is
// refused, never ignored. The four maintenance writers (no HTTP route) take exactly their own controlled fields and
// never accept descriptor text.

export const isCodingReleaseUuid = (value: unknown): value is string => isClaimStructureUuid(value)

export function refusedReadRequest(query: unknown, body: unknown): string | null {
  const queryKeys = isPlainObject(query) ? Object.keys(query) : []
  if (queryKeys.length > 0) return `unsupported query parameter(s): ${queryKeys.join(', ')}`
  if (body !== undefined && !(isPlainObject(body) && Object.keys(body).length === 0)) return 'the read carries no body'
  return null
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string }

const exactKeys = (body: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return `unsupported field(s): ${unknown.join(', ')}`
  const missing = allowed.filter((key) => !(key in body))
  return missing.length > 0 ? `missing field(s): ${missing.join(', ')}` : null
}
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const SCOPE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const scopeCode = (value: unknown): string | null => (typeof value === 'string' && SCOPE_CODE.test(value.trim()) ? value.trim().toUpperCase() : null)
const boundedText = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\u0000-\u001f]/.test(value) ? value.trim() : null)

// One dataset's identity: the A3 dataset id, one controlled code system and one controlled purpose.
export function validateDatasetCodeSystem(body: unknown): Validated<{ datasetId: string; codeSystem: CodeSystem; purpose: MappingPurpose }> {
  if (!isPlainObject(body)) return { ok: false, message: 'the request must be an object' }
  const fields = body as Record<string, unknown>
  const keys = exactKeys(fields, ['datasetId', 'codeSystem', 'purpose'])
  if (keys) return { ok: false, message: keys }
  if (!isCodingReleaseUuid(fields.datasetId)) return { ok: false, message: 'invalid dataset id' }
  if (!oneOf(codeSystems, fields.codeSystem)) return { ok: false, message: 'unknown code system' }
  if (!oneOf(mappingPurposes, fields.purpose)) return { ok: false, message: 'unknown purpose' }
  return { ok: true, value: { datasetId: fields.datasetId.toLowerCase(), codeSystem: fields.codeSystem, purpose: fields.purpose } }
}

// One rights decision for a code system in one jurisdiction and authority, with a reference to its basis.
export function validateRightsDecision(body: unknown): Validated<{ jurisdictionCode: string; authorityCode: string; codeSystem: CodeSystem; rightsStatus: RightsStatus; decisionReference: string }> {
  if (!isPlainObject(body)) return { ok: false, message: 'the request must be an object' }
  const fields = body as Record<string, unknown>
  const keys = exactKeys(fields, ['jurisdictionCode', 'authorityCode', 'codeSystem', 'rightsStatus', 'decisionReference'])
  if (keys) return { ok: false, message: keys }
  const jurisdictionCode = scopeCode(fields.jurisdictionCode)
  const authorityCode = scopeCode(fields.authorityCode)
  if (!jurisdictionCode || !authorityCode) return { ok: false, message: 'jurisdiction and authority must be controlled codes' }
  if (!oneOf(codeSystems, fields.codeSystem)) return { ok: false, message: 'unknown code system' }
  if (!oneOf(rightsStatuses, fields.rightsStatus)) return { ok: false, message: 'unknown rights status' }
  const decisionReference = boundedText(fields.decisionReference, 200)
  if (!decisionReference) return { ok: false, message: 'a decision reference of at most 200 characters is required' }
  return { ok: true, value: { jurisdictionCode, authorityCode, codeSystem: fields.codeSystem, rightsStatus: fields.rightsStatus, decisionReference } }
}

// The largest count a PostgreSQL integer column holds: a type bound, not a release-size limit (audit CRG-F01). The
// total size of a release is otherwise unbounded; the importer writes it in fixed-size batches inside one transaction.
export const MAX_DECLARED_ROWS = 2_147_483_647
// Canonical base64, checked linearly (a grouped repetition would recurse on a multi-megabyte artifact): only the
// alphabet with at most two trailing '=', a length divisible by four, and an exact round trip (below).
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/
const isCanonicalBase64Text = (value: string) => value.length > 0 && value.length % 4 === 0 && BASE64_ALPHABET.test(value)

// One release import: the A3 version, the original source artifact (its format and bytes, base64), the artifact's
// SHA-256 and the membership fingerprint the caller expects, where it came from, who published it and how many records
// it declares. The membership rows are never supplied: the importer reads them from the artifact itself.
export function validateReleaseImport(body: unknown): Validated<{
  datasetVersionId: string
  artifactFormat: ArtifactFormat
  artifact: Buffer
  sourceFileSha256: string
  membershipFingerprintSha256: string
  sourceUri: string
  publisher: string
  expectedRowCount: number
}> {
  if (!isPlainObject(body)) return { ok: false, message: 'the request must be an object' }
  const fields = body as Record<string, unknown>
  const keys = exactKeys(fields, ['datasetVersionId', 'artifactFormat', 'artifactBase64', 'sourceFileSha256', 'membershipFingerprintSha256', 'sourceUri', 'publisher', 'expectedRowCount'])
  if (keys) return { ok: false, message: keys }
  if (!isCodingReleaseUuid(fields.datasetVersionId)) return { ok: false, message: 'invalid dataset version id' }
  if (!oneOf(ARTIFACT_FORMATS, fields.artifactFormat)) return { ok: false, message: 'the artifact format is not readable in this checkpoint (real catalogue formats remain blocked pending approval)' }
  if (typeof fields.artifactBase64 !== 'string' || !isCanonicalBase64Text(fields.artifactBase64)) return { ok: false, message: 'the artifact must be non-empty canonical base64' }
  const artifact = Buffer.from(fields.artifactBase64, 'base64')
  if (artifact.toString('base64') !== fields.artifactBase64) return { ok: false, message: 'the artifact must be non-empty canonical base64' }
  if (typeof fields.sourceFileSha256 !== 'string' || !SHA256_HEX.test(fields.sourceFileSha256)) return { ok: false, message: 'the source artifact fingerprint must be a lower-case SHA-256' }
  if (typeof fields.membershipFingerprintSha256 !== 'string' || !SHA256_HEX.test(fields.membershipFingerprintSha256)) return { ok: false, message: 'the membership fingerprint must be a lower-case SHA-256' }
  const sourceUri = boundedText(fields.sourceUri, 500)
  if (!sourceUri || !/^(https:\/\/|synthetic:)/.test(sourceUri)) return { ok: false, message: 'the source URI must be an https or synthetic: reference' }
  const publisher = boundedText(fields.publisher, 120)
  if (!publisher) return { ok: false, message: 'a publisher of at most 120 characters is required' }
  if (!Number.isInteger(fields.expectedRowCount) || (fields.expectedRowCount as number) < 1 || (fields.expectedRowCount as number) > MAX_DECLARED_ROWS) return { ok: false, message: 'the expected row count must be a positive integer' }
  return {
    ok: true,
    value: {
      datasetVersionId: fields.datasetVersionId.toLowerCase(),
      artifactFormat: fields.artifactFormat,
      artifact,
      sourceFileSha256: fields.sourceFileSha256,
      membershipFingerprintSha256: fields.membershipFingerprintSha256,
      sourceUri,
      publisher,
      expectedRowCount: fields.expectedRowCount as number,
    },
  }
}

// One retirement classification of a RETIRED edition.
export function validateRetirementClassification(body: unknown): Validated<{ datasetVersionId: string; classification: RetirementClassification }> {
  if (!isPlainObject(body)) return { ok: false, message: 'the request must be an object' }
  const fields = body as Record<string, unknown>
  const keys = exactKeys(fields, ['datasetVersionId', 'classification'])
  if (keys) return { ok: false, message: keys }
  if (!isCodingReleaseUuid(fields.datasetVersionId)) return { ok: false, message: 'invalid dataset version id' }
  if (!oneOf(retirementClassifications, fields.classification)) return { ok: false, message: 'unknown retirement classification' }
  return { ok: true, value: { datasetVersionId: fields.datasetVersionId.toLowerCase(), classification: fields.classification } }
}
