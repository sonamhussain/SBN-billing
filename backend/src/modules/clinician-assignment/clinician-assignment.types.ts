// A4.2 — one module owns both assignment relationships, because they share exactly one lifecycle
// (create, then close once) and one concurrency contract (serialize on the clinician row). An
// assignment records an operational fact — "this clinician practised here / in this specialty
// between these dates" — and nothing else: no licence, no credential, no payer participation and
// no encounter.

export type AssignmentKind = 'FACILITY' | 'SPECIALTY'

export type ClinicianFacilityAssignmentDto = {
  id: string
  clinicianId: string
  facilityId: string
  effectiveFrom: string
  effectiveTo: string | null
  createdAt: string
  updatedAt: string
}

export type ClinicianSpecialtyAssignmentDto = {
  id: string
  clinicianId: string
  specialtyId: string
  effectiveFrom: string
  effectiveTo: string | null
  createdAt: string
  updatedAt: string
}

// The shared A1 error vocabulary is reused unchanged: an overlapping period is a refused business
// rule, reported as VALIDATION_ERROR with a message naming the conflicting assignment.
export type ClinicianAssignmentErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type ClinicianAssignmentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ClinicianAssignmentErrorCode; message: string }

// The defensive zero/one/many contract A4.4 will consume. A corrupted history that somehow holds
// two effective rows for one exact pair fails closed instead of picking a winner.
export type AssignmentResolution<T> =
  | { status: 'RESOLVED'; assignment: T }
  | { status: 'NO_MATCH' }
  | { status: 'INTEGRITY_CONFLICT'; matchedIds: string[] }

// The only fields a client may supply. clinicianId comes from the route, and id/createdAt/updatedAt
// are server-owned.
export const assignmentCreateFields = ['facilityId', 'specialtyId', 'effectiveFrom', 'effectiveTo'] as const
export const assignmentCloseFields = ['effectiveTo'] as const
export const assignmentServerOwnedFields = ['id', 'clinicianId', 'createdAt', 'updatedAt'] as const
