const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeProcedureCodeInternalCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeProcedureCodeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export type OptionalFieldResult =
  | { ok: true; value: string | null }
  | { ok: false }

export function normalizeOptionalCodeField(value: unknown): OptionalFieldResult {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const normalized = value.trim()
  return { ok: true, value: normalized.length > 0 ? normalized : null }
}

export function isProcedureCodeUuid(value: string): boolean {
  return uuidShape.test(value)
}
