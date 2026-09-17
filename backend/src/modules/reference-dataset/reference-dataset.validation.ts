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

export function isReferenceDatasetActivationStatus(value: unknown): value is ReferenceDatasetActivationStatus {
  return typeof value === 'string' && (referenceDatasetActivationStatuses as readonly string[]).includes(value)
}

// Audit F11 — ACTIVE implies VALIDATED, durably and not only at the moment of activation.
// Validation used to be decided on its own, so an ACTIVE version could be downgraded to
// UNVALIDATED or REJECTED while it stayed ACTIVE. An active dataset version is in force: a
// controlled invalidation must withdraw the active state first (retire it, or activate a
// different validated version), and only then change validation. The decision is pure so the
// same rule is used by the service and provable without a database.
export type DatasetValidationDecision =
  | { kind: 'allowed' }
  | { kind: 'rejected'; message: string }

export function decideDatasetValidationChange(
  current: { activationStatus: string; validationStatus: string },
  requested: ReferenceDatasetValidationStatus,
): DatasetValidationDecision {
  if (current.activationStatus === 'RETIRED')
    return { kind: 'rejected', message: 'reference dataset version is retired and cannot be changed' }

  // REJECTED is terminal for validation (T51) — no further transition, in either direction.
  if (current.validationStatus === 'REJECTED')
    return { kind: 'rejected', message: 'reference dataset version validation is already REJECTED and cannot be changed' }

  if (current.activationStatus === 'ACTIVE' && requested !== 'VALIDATED')
    return {
      kind: 'rejected',
      message:
        'an ACTIVE reference dataset version cannot be downgraded to ' +
        `${requested}; withdraw the active state first by retiring it or activating another VALIDATED version`,
    }

  return { kind: 'allowed' }
}
