import { isClaimStructureUuid, isPlainObject } from '../claim-line/claim-line.validation.ts'
import { canonicalCode } from './coding-release.resolver.ts'
import {
  SHA256_HEX,
  SOURCE_ROW_ID,
  codeSystems,
  mappingPurposes,
  retirementClassifications,
  rightsStatuses,
  type CodeSystem,
  type ImportRow,
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

export const MAX_IMPORT_ROWS = 5000

// One release import: the A3 version, the source file's SHA-256, where it came from, who published it, how many rows
// it declares, and its rows. Every row is a source row id, a canonical code and the row's SHA-256; ids and codes are
// unique within the import.
export function validateReleaseImport(body: unknown): Validated<{ datasetVersionId: string; sourceFileSha256: string; sourceUri: string; publisher: string; expectedRowCount: number; rows: ImportRow[] }> {
  if (!isPlainObject(body)) return { ok: false, message: 'the request must be an object' }
  const fields = body as Record<string, unknown>
  const keys = exactKeys(fields, ['datasetVersionId', 'sourceFileSha256', 'sourceUri', 'publisher', 'expectedRowCount', 'rows'])
  if (keys) return { ok: false, message: keys }
  if (!isCodingReleaseUuid(fields.datasetVersionId)) return { ok: false, message: 'invalid dataset version id' }
  if (typeof fields.sourceFileSha256 !== 'string' || !SHA256_HEX.test(fields.sourceFileSha256)) return { ok: false, message: 'the source file fingerprint must be a lower-case SHA-256' }
  const sourceUri = boundedText(fields.sourceUri, 500)
  if (!sourceUri || !/^(https:\/\/|synthetic:)/.test(sourceUri)) return { ok: false, message: 'the source URI must be an https or synthetic: reference' }
  const publisher = boundedText(fields.publisher, 120)
  if (!publisher) return { ok: false, message: 'a publisher of at most 120 characters is required' }
  if (!Number.isInteger(fields.expectedRowCount) || (fields.expectedRowCount as number) < 1 || (fields.expectedRowCount as number) > MAX_IMPORT_ROWS) return { ok: false, message: `the expected row count must be 1 to ${MAX_IMPORT_ROWS}` }
  if (!Array.isArray(fields.rows) || fields.rows.length === 0 || fields.rows.length > MAX_IMPORT_ROWS) return { ok: false, message: `rows must be a list of 1 to ${MAX_IMPORT_ROWS} entries` }
  const rows: ImportRow[] = []
  const ids = new Set<string>()
  const codes = new Set<string>()
  for (const entry of fields.rows) {
    if (!isPlainObject(entry)) return { ok: false, message: 'every row must be an object' }
    const item = entry as Record<string, unknown>
    const itemKeys = exactKeys(item, ['sourceRowId', 'code', 'sourceRowSha256'])
    if (itemKeys) return { ok: false, message: `row: ${itemKeys}` }
    if (typeof item.sourceRowId !== 'string' || !SOURCE_ROW_ID.test(item.sourceRowId)) return { ok: false, message: 'a source row id is not a controlled identifier' }
    const code = canonicalCode(item.code)
    if (!code) return { ok: false, message: 'a code is not a canonical code value' }
    if (typeof item.sourceRowSha256 !== 'string' || !SHA256_HEX.test(item.sourceRowSha256)) return { ok: false, message: 'a source row fingerprint is not a lower-case SHA-256' }
    if (ids.has(item.sourceRowId)) return { ok: false, message: 'a source row id appears more than once' }
    if (codes.has(code)) return { ok: false, message: 'a code appears more than once' }
    ids.add(item.sourceRowId)
    codes.add(code)
    rows.push({ sourceRowId: item.sourceRowId, code, sourceRowSha256: item.sourceRowSha256 })
  }
  return {
    ok: true,
    value: { datasetVersionId: fields.datasetVersionId.toLowerCase(), sourceFileSha256: fields.sourceFileSha256, sourceUri, publisher, expectedRowCount: fields.expectedRowCount as number, rows },
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
