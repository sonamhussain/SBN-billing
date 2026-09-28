import { formatDateOnly, parseStrictDateOnly, parseStrictTimestamp, utcDateOf } from '../../shared/rules/date-only.ts'
import {
  evidenceServerOwnedFields,
  evidenceVersionInputFields,
  type EvidenceArtifactVersionDto,
  type EvidenceVersionInput,
} from './evidence-artifact.types.ts'

// A5.1 — the pure validation contract. No database access lives here, so every rule is
// unit-testable on its own and there is exactly one copy of each decision.
//
// The shared strict date and instant parsers are reused; there is deliberately no second date
// parser in this module. Error messages name the field that was wrong and never echo the storage
// reference, the hash or any other evidence metadata back to the caller.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isEvidenceUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const STORAGE_REF_MAX = 1024
const DOCUMENT_TYPE_MAX = 120
const SHA256_HEX = /^[0-9a-f]{64}$/

// A received instant may sit a little ahead of this server's clock without being wrong: the caller
// and the database can disagree by seconds, and rejecting that would fail honest writes. What the
// rule is really guarding against is a date that has not happened yet, so a small allowance is
// granted and anything beyond it is refused.
const FUTURE_INSTANT_TOLERANCE_MS = 5 * 60 * 1000

const hasControlCharacters = (value: string) => /[\r\n]/.test(value)

export function normalizeStorageRef(value: unknown): Outcome<string> {
  if (typeof value !== 'string') return { ok: false, message: 'storageRef is required' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: 'storageRef is required' }
  if (hasControlCharacters(trimmed)) return { ok: false, message: 'storageRef must not contain a line break' }
  if (trimmed.length > STORAGE_REF_MAX) return { ok: false, message: `storageRef must be at most ${STORAGE_REF_MAX} characters` }
  // Deliberately no URL, path, bucket or provider parsing: the reference is opaque, and treating it
  // as any particular storage shape would couple this domain to a vendor it has not chosen.
  return { ok: true, value: trimmed }
}

// §7 — the approved behaviour is trim + lowercase, then validate. An uppercase digest names exactly
// the same bytes, so refusing it would be pedantry; what matters is that exactly one canonical form
// is ever stored, so two records of the same content always compare equal.
export function normalizeContentHash(value: unknown): Outcome<string> {
  if (typeof value !== 'string') return { ok: false, message: 'contentHash is required' }
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return { ok: false, message: 'contentHash is required' }
  if (!SHA256_HEX.test(normalized))
    return { ok: false, message: 'contentHash must be a 64-character hexadecimal SHA-256 digest' }
  return { ok: true, value: normalized }
}

export function normalizeDocumentType(value: unknown): Outcome<string> {
  if (typeof value !== 'string') return { ok: false, message: 'documentType is required' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: 'documentType is required' }
  if (hasControlCharacters(trimmed)) return { ok: false, message: 'documentType must not contain a line break' }
  if (trimmed.length > DOCUMENT_TYPE_MAX) return { ok: false, message: `documentType must be at most ${DOCUMENT_TYPE_MAX} characters` }
  // Opaque on purpose. No payer or UAE document vocabulary is assumed, because guessing one here
  // would freeze a classification this package has no authority to define.
  return { ok: true, value: trimmed }
}

// Absent or null both mean "the source date is unknown", which is a real and useful answer. It is
// never filled in from receivedAt: when the evidence was received says nothing about when it was
// issued.
export function normalizeSourceDate(value: unknown, now: Date): Outcome<Date | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  const parsed = parseStrictDateOnly(value)
  if (!parsed) return { ok: false, message: 'sourceDate must be a real calendar date in YYYY-MM-DD format, or null' }
  const today = utcDateOf(now)
  if (today && parsed.getTime() > today.getTime()) return { ok: false, message: 'sourceDate must not be in the future' }
  return { ok: true, value: parsed }
}

export function normalizeReceivedAt(value: unknown, now: Date): Outcome<Date> {
  const parsed = parseStrictTimestamp(value)
  if (!parsed) return { ok: false, message: 'receivedAt must be a valid ISO-8601 instant' }
  if (parsed.getTime() > now.getTime() + FUTURE_INSTANT_TOLERANCE_MS)
    return { ok: false, message: 'receivedAt must not be in the future' }
  return { ok: true, value: parsed }
}

function suppliedKeys(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return []
  return Object.keys(body as Record<string, unknown>)
}

// One body shape serves both creating an artifact with its first version and appending a later one:
// the caller describes a representation, and the server decides which version number it becomes.
export function validateVersionBody(body: unknown, now: Date): Outcome<EvidenceVersionInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, message: 'an evidence version body is required' }

  const keys = suppliedKeys(body)
  const serverOwned = evidenceServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0)
    return { ok: false, message: `${serverOwned.join(', ')} is derived by the server and cannot be supplied` }

  const allowed = new Set<string>(evidenceVersionInputFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  const record = body as Record<string, unknown>

  const storageRef = normalizeStorageRef(record.storageRef)
  if (!storageRef.ok) return storageRef
  const contentHash = normalizeContentHash(record.contentHash)
  if (!contentHash.ok) return contentHash
  const documentType = normalizeDocumentType(record.documentType)
  if (!documentType.ok) return documentType
  const sourceDate = normalizeSourceDate(record.sourceDate, now)
  if (!sourceDate.ok) return sourceDate
  const receivedAt = normalizeReceivedAt(record.receivedAt, now)
  if (!receivedAt.ok) return receivedAt

  return {
    ok: true,
    value: {
      storageRef: storageRef.value,
      contentHash: contentHash.value,
      documentType: documentType.value,
      sourceDate: sourceDate.value,
      receivedAt: receivedAt.value,
    },
  }
}

// The server owns the number. A client-supplied version would let a caller overwrite history by
// claiming a number that already exists, or leave a gap by skipping one.
export function nextVersionNumber(currentMax: number | null): number {
  return (currentMax ?? 0) + 1
}

export type StoredVersion = {
  id: string
  evidenceArtifactId: string
  version: number
  storageRef: string
  contentHash: string
  documentType: string
  sourceDate: Date | null
  receivedAt: Date
  createdByUserId: string
  createdAt: Date
}

export function toEvidenceVersionDto(record: StoredVersion): EvidenceArtifactVersionDto {
  return {
    id: record.id,
    evidenceArtifactId: record.evidenceArtifactId,
    version: record.version,
    storageRef: record.storageRef,
    contentHash: record.contentHash,
    documentType: record.documentType,
    sourceDate: formatDateOnly(record.sourceDate),
    receivedAt: record.receivedAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

// The audit snapshot for an evidence action. It names the row and when it happened, and carries
// none of what the row describes: a storage reference, a hash, a document type or a source date
// would turn the audit trail into a second evidence store, and evidence metadata alone can reveal
// clinical and insurance workflow.
export function evidenceAuditSnapshot(record: { id: string; version?: number; evidenceArtifactId?: string; organizationId?: string; createdAt: Date }) {
  return {
    id: record.id,
    ...(record.version !== undefined ? { version: record.version } : {}),
    ...(record.evidenceArtifactId !== undefined ? { evidenceArtifactId: record.evidenceArtifactId } : {}),
    ...(record.organizationId !== undefined ? { organizationId: record.organizationId } : {}),
    createdAt: record.createdAt.toISOString(),
  }
}
