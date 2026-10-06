import type { ExternalIdentifierDto } from './external-identifier.types.ts'
import { deriveTargetFromRecord, type PersistedTargetColumns } from './external-identifier.target.ts'

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ExternalIdentifierRecord = PersistedTargetColumns & {
  id: string
  organizationId: string
  sourceSystem: string
  externalValue: string
  createdAt: Date
  updatedAt: Date
}

// The canonical wire shape of an external identifier: an opaque source/value pair and ONE typed
// target derived from whichever FK column is set. It lives here, beside the other pure helpers and
// matching every other module's layout, because more than one reader now needs it — A4.9 composes
// these mappings into the billing context and must not reproduce the derivation.
export function toExternalIdentifierDto(record: ExternalIdentifierRecord): ExternalIdentifierDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    sourceSystem: record.sourceSystem,
    externalValue: record.externalValue,
    target: deriveTargetFromRecord(record),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export function normalizeSourceSystem(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeExternalValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function isExternalIdentifierUuid(value: string): boolean {
  return uuidShape.test(value)
}

// A4.8 — a PATCH may change the source namespace and the external value, and nothing else. The
// route used to read five named fields off the body, which meant any other key rode along
// unnoticed: `{ sourceSystem, patientId }` updated the source and silently discarded the attempted
// retarget, so a caller could believe the target had moved. The body is now judged as a whole, and
// an unknown or immutable field fails the entire request rather than part of it.
export const externalIdentifierUpdatableFields = ['sourceSystem', 'externalValue'] as const

// Named separately so the long-standing "target cannot be changed" refusal keeps its own message
// instead of being folded into a generic unknown-field list.
const targetFields = ['target', 'targetType', 'targetId']

export type UpdateBodyOutcome =
  | { ok: true; sourceSystem: unknown; externalValue: unknown }
  | { ok: false; message: string }

export function validateUpdateBody(body: unknown): UpdateBodyOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, message: 'an external identifier update body is required' }

  const record = body as Record<string, unknown>
  const keys = Object.keys(record)

  if (targetFields.some((field) => keys.includes(field)))
    return { ok: false, message: 'target cannot be changed' }

  const invalid = keys.filter(
    (key) => !(externalIdentifierUpdatableFields as readonly string[]).includes(key),
  )
  if (invalid.length > 0)
    return { ok: false, message: `unknown or immutable field(s): ${invalid.join(', ')}` }

  if (keys.length === 0) return { ok: false, message: 'at least one field is required' }

  return { ok: true, sourceSystem: record.sourceSystem, externalValue: record.externalValue }
}
