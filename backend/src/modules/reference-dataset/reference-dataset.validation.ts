const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isReferenceDatasetUuid(value: string): boolean {
  return uuidShape.test(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeDatasetKey(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeReferenceDatasetDisplayName(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeReferenceDatasetJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeReferenceDatasetAuthorityCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeContentHash(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeReferenceDatasetVersion(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export const referenceDatasetValidationStatuses = ['UNVALIDATED', 'VALIDATED', 'REJECTED'] as const
export type ReferenceDatasetValidationStatus = (typeof referenceDatasetValidationStatuses)[number]

export function isReferenceDatasetValidationStatus(value: unknown): value is ReferenceDatasetValidationStatus {
  return typeof value === 'string' && (referenceDatasetValidationStatuses as readonly string[]).includes(value)
}

export const referenceDatasetActivationStatuses = ['INACTIVE', 'ACTIVE', 'SUPERSEDED', 'RETIRED'] as const
export type ReferenceDatasetActivationStatus = (typeof referenceDatasetActivationStatuses)[number]
