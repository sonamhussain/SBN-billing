// A4.1 — Patient is the canonical organization-scoped person identity and a deliberately small,
// jurisdiction-neutral demographic profile. It answers only "who is this person inside this
// Organization?". Coverage (A4.3), service events (A4.4) and external identifiers (A4.8) attach
// later and are never stored here.

export type PatientDto = {
  id: string
  organizationId: string
  givenName: string
  middleName: string | null
  familyName: string
  // Derived for DTO/UI convenience only — never persisted as a competing name truth.
  displayName: string
  // Always a calendar date string, never a timestamp.
  dateOfBirth: string
  mobilePhone: string | null
  email: string | null
  createdAt: string
  updatedAt: string
}

export type PatientErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type PatientResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PatientErrorCode; message: string }

// The fields a client may supply. id, organizationId, createdAt and updatedAt are server-owned and
// are rejected, never silently ignored.
export const patientCreateFields = ['givenName', 'middleName', 'familyName', 'dateOfBirth', 'mobilePhone', 'email'] as const
export const patientUpdateFields = patientCreateFields
export const patientImmutableFields = ['id', 'organizationId', 'createdAt', 'updatedAt'] as const
