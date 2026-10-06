// A5.1 owns the documentType label. A requirement's accepted types are compared against exactly
// those stored labels, so they are normalized by exactly the same rule: trimmed, nonblank, no line
// break, bounded length, case preserved. A second normalizer is how a type gets accepted on one side
// and never matched on the other.
import { normalizeDocumentType } from '../evidence-artifact/evidence-artifact.validation.ts'
import type { EvidenceRequirementDto, EvidenceRequirementInput } from './evidence-requirement.types.ts'

// A5.6 — the pure payload rules. No database access lives here. Messages name the field, never the
// submitted value.

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isEvidenceRequirementUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

const requirementFields = ['documentTypes', 'minimumCount', 'sourceDateRequired', 'maxSourceAgeDays'] as const
// Refused by name rather than ignored: none of these is the caller's to choose, and the scope ones
// belong to A3 RuleApplicability, never to the payload.
const requirementServerOwned = [
  'id',
  'ruleVersionId',
  'createdAt',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'providerContractId',
  'tariffScheduleId',
  'tariffScheduleVersionId',
  'facilityId',
  'serviceId',
  'procedureCodeId',
  'diagnosisCodeId',
  'jurisdictionCode',
] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateRequirementBody(body: unknown): Outcome<EvidenceRequirementInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'a requirement body object is required' }
  const keys = Object.keys(body)
  const serverOwned = requirementServerOwned.filter((field) => keys.includes(field))
  if (serverOwned.length > 0) return { ok: false, message: `${serverOwned.join(', ')} is not part of a requirement payload` }
  const allowed = new Set<string>(requirementFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  // At least one accepted type. Several are alternatives for this one requirement; two independent
  // documents are two governed rules, so there is no AND list here.
  if (!Array.isArray(body.documentTypes) || body.documentTypes.length === 0)
    return { ok: false, message: 'documentTypes must be a non-empty array' }
  const documentTypes: string[] = []
  for (const entry of body.documentTypes) {
    const normalized = normalizeDocumentType(entry)
    if (!normalized.ok) return { ok: false, message: `documentTypes: ${normalized.message}` }
    if (documentTypes.includes(normalized.value)) return { ok: false, message: 'documentTypes must not repeat a document type' }
    documentTypes.push(normalized.value)
  }

  if (typeof body.minimumCount !== 'number' || !Number.isInteger(body.minimumCount) || body.minimumCount < 1)
    return { ok: false, message: 'minimumCount must be a positive integer' }

  if (typeof body.sourceDateRequired !== 'boolean') return { ok: false, message: 'sourceDateRequired must be true or false' }

  let maxSourceAgeDays: number | null = null
  if (body.maxSourceAgeDays !== undefined && body.maxSourceAgeDays !== null) {
    if (typeof body.maxSourceAgeDays !== 'number' || !Number.isInteger(body.maxSourceAgeDays) || body.maxSourceAgeDays < 0)
      return { ok: false, message: 'maxSourceAgeDays must be null or a non-negative integer' }
    // A freshness limit cannot be judged without a source date.
    if (!body.sourceDateRequired) return { ok: false, message: 'maxSourceAgeDays requires sourceDateRequired to be true' }
    maxSourceAgeDays = body.maxSourceAgeDays
  }

  return { ok: true, value: { documentTypes, minimumCount: body.minimumCount, sourceDateRequired: body.sourceDateRequired, maxSourceAgeDays } }
}

export type StoredRequirement = {
  id: string
  ruleVersionId: string
  minimumCount: number
  sourceDateRequired: boolean
  maxSourceAgeDays: number | null
  createdAt: Date
  documentTypes: { documentType: string }[]
}

// Sorted by code unit, never locale: the order must not depend on the server's language settings.
export const sortedDocumentTypes = (rows: { documentType: string }[]) =>
  rows.map((row) => row.documentType).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

export function toRequirementDto(record: StoredRequirement): EvidenceRequirementDto {
  return {
    id: record.id,
    ruleVersionId: record.ruleVersionId,
    documentTypes: sortedDocumentTypes(record.documentTypes),
    minimumCount: record.minimumCount,
    sourceDateRequired: record.sourceDateRequired,
    maxSourceAgeDays: record.maxSourceAgeDays,
    createdAt: record.createdAt.toISOString(),
  }
}

// The audit trail proves the payload was attached, by which row, to which version, and when. The
// document types and limits are deliberately absent: they are governed content, owned by the row.
export const requirementAuditSnapshot = (record: { id: string; ruleVersionId: string; createdAt: Date }) => ({
  id: record.id,
  ruleVersionId: record.ruleVersionId,
  createdAt: record.createdAt.toISOString(),
})

// The completeness target. Only the two optional exact-row references may be supplied; everything a
// governed rule is matched on is derived server-side from the Encounter, A5.5 and these rows.
const targetFields = ['encounterActivityId', 'encounterDiagnosisId'] as const

export type CompletenessTarget = { encounterActivityId: string | null; encounterDiagnosisId: string | null }

export function validateCompletenessTarget(body: unknown): Outcome<CompletenessTarget> {
  if (body === undefined || body === null) return { ok: true, value: { encounterActivityId: null, encounterDiagnosisId: null } }
  if (!isPlainObject(body)) return { ok: false, message: 'the evaluation body must be an object' }
  const unknown = Object.keys(body).filter((key) => !(targetFields as readonly string[]).includes(key))
  // Every other field — service, procedure, diagnosis code, payer, contract, tariff, businessDate,
  // rule version, evidence — is refused by name: the client never supplies the context or a winner.
  if (unknown.length > 0) return { ok: false, message: `field(s) not accepted for evaluation: ${unknown.join(', ')}` }
  const target: CompletenessTarget = { encounterActivityId: null, encounterDiagnosisId: null }
  for (const field of targetFields) {
    const value = body[field]
    if (value === undefined || value === null) continue
    if (!isEvidenceRequirementUuid(value)) return { ok: false, message: `${field} must be a UUID or null` }
    target[field] = value
  }
  return { ok: true, value: target }
}
