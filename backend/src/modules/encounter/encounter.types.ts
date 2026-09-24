// A4.4 — an Encounter is one patient service event: which patient, at which facility, with which
// clinician, on which service date, and — resolved by the server, never supplied by the client —
// which exact ClinicianFacilityAssignment (A4.2) and ACTIVE FacilityRegulatoryProfile (A3) applied
// on that date, plus the recorded InsuranceMembership (A4.3) if one was selected. It does not prove
// eligibility, authorization, coding completeness, claim readiness, price or payment.

export type EncounterDto = {
  id: string
  patientId: string
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  // A calendar date (YYYY-MM-DD), never a timestamp.
  serviceDate: string
  // Server-resolved context stored at write time.
  clinicianFacilityAssignmentId: string
  facilityRegulatoryProfileId: string
  createdAt: string
  updatedAt: string
}

export type EncounterErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type EncounterResult<T> = { ok: true; value: T } | { ok: false; code: EncounterErrorCode; message: string }

// The only fields a client may supply. patientId comes from the route; the context IDs are
// resolved by the server; id/createdAt/updatedAt are server-owned. Supplying any of those is
// rejected, never silently ignored.
export const encounterWritableFields = ['facilityId', 'clinicianId', 'insuranceMembershipId', 'serviceDate'] as const
export type EncounterWritableField = (typeof encounterWritableFields)[number]

export const encounterServerOwnedFields = [
  'id',
  'patientId',
  'clinicianFacilityAssignmentId',
  'facilityRegulatoryProfileId',
  'createdAt',
  'updatedAt',
] as const
