import type { Encounter } from '../encounter/encounter.types.ts'

// FE-03 — the A4.9 EncounterBillingContextV1 aggregate, read from one database snapshot. It is a current
// read, not history, and deliberately carries no eligibility, authorization, readiness, pricing or claim
// field. The panel shows it as received; it is never rebuilt from the separate section queries.

export type ExternalReference = {
  id: string
  sourceSystem: string
  externalValue: string
}

export type EncounterBillingContext = {
  schemaVersion: 'EncounterBillingContextV1'
  // When the bundle was assembled. Never a service or effective date.
  assembledAt: string
  organizationId: string
  encounter: Encounter
  facility: { id: string; name: string }
  clinician: { id: string; displayName: string }
  // null means only that no membership was selected on this Encounter.
  insuranceMembership: { id: string; payerId: string; memberIdentifier: string } | null
  // The exact rows the Encounter stored at write time, never a newer substitute.
  providerContext: {
    clinicianFacilityAssignment: {
      id: string
      effectiveFrom: string
      effectiveTo: string | null
    }
    facilityRegulatoryProfile: {
      id: string
      jurisdictionCode: string
      regulatoryAuthorityCode: string
      effectiveFrom: string
      effectiveTo: string | null
      status: string
    }
  }
  externalIdentifiers: {
    patient: ExternalReference[]
    encounter: ExternalReference[]
  }
}
