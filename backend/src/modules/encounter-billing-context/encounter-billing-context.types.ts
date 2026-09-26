import type { EncounterDto } from '../encounter/encounter.types.ts'
import type { InsuranceMembershipDto } from '../insurance-membership/insurance-membership.types.ts'
import type { FacilityRegulatoryProfileDto } from '../facility-regulatory/facility-regulatory.types.ts'
import type { ExternalIdentifierDto } from '../external-identifier/external-identifier.types.ts'
import type { EncounterDiagnosisDto } from '../encounter-diagnosis/encounter-diagnosis.types.ts'
import type { EncounterActivityDto } from '../encounter-activity/encounter-activity.types.ts'
import type { EncounterObservationDto } from '../encounter-observation/encounter-observation.types.ts'

// A4.9 — EncounterBillingContextV1 answers one question: what is the canonical billing-relevant
// context of this Encounter right now, read from a single consistent database snapshot? It creates
// no new billing fact, no eligibility result, no authorization state, no rule decision, no contract
// or tariff selection, no readiness verdict, no claim and no submission snapshot. It composes
// existing A4 truth and verifies that the stored relationships still cohere.
//
// It is ephemeral on purpose. A6 owns the immutable submitted snapshot; a repeated call here may
// legitimately differ after an upstream correction, and that is the contract, not a defect.

// The exact assignment DTO A4.2 returns for a facility assignment. Declared structurally because
// A4.2 exposes it through a DTO function rather than a named exported type.
export type ClinicianFacilityAssignmentDto = {
  id: string
  clinicianId: string
  facilityId: string
  effectiveFrom: string
  effectiveTo: string | null
  createdAt: string
  updatedAt: string
}

// The billing-identity projection of a Patient. Phone and email are deliberately absent: this is a
// billing handoff, and no downstream requirement has proven a need for contact details yet.
export type BillingContextPatient = {
  id: string
  organizationId: string
  givenName: string
  middleName: string | null
  familyName: string
  displayName: string
  dateOfBirth: string
  updatedAt: string
}

export type EncounterBillingContextV1 = {
  schemaVersion: 'EncounterBillingContextV1'
  // The transaction timestamp of the read. It is when the bundle was assembled, never a business
  // effective date, and never a substitute for an A6 submission time.
  assembledAt: string
  organizationId: string

  encounter: EncounterDto

  patient: BillingContextPatient

  facility: { id: string; name: string }
  clinician: { id: string; displayName: string }

  // null means only "no membership was selected on this Encounter". It does NOT mean self-pay,
  // uninsured or ineligible; A5 owns evidence-bearing eligibility.
  insuranceMembership: InsuranceMembershipDto | null

  // The EXACT rows the Encounter stored at write time, never a newer or currently-effective
  // substitute. A later administrative lifecycle change does not authorize replacement.
  providerContext: {
    clinicianFacilityAssignment: ClinicianFacilityAssignmentDto
    facilityRegulatoryProfile: FacilityRegulatoryProfileDto
  }

  diagnoses: EncounterDiagnosisDto[]
  activities: EncounterActivityDto[]
  observations: EncounterObservationDto[]

  // Every mapping that targets this Patient or this Encounter, in a deterministic order. A4.9
  // chooses no preferred identifier: the consumer selects by the sourceSystem its real integration
  // contract requires.
  externalIdentifiers: {
    patient: ExternalIdentifierDto[]
    encounter: ExternalIdentifierDto[]
  }
}

export type EncounterBillingContextErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INTEGRITY_CONFLICT'

export type EncounterBillingContextResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EncounterBillingContextErrorCode; message: string }
