// FE-03 — the A4.4 Encounter contract. One patient service event: which facility, which clinician, which
// service date and which recorded membership. The assignment and regulatory profile IDs are resolved
// and stored by the server; the client never supplies them. Nothing here proves eligibility,
// authorization, coding completeness, claim readiness or price.
export type Encounter = {
  id: string
  patientId: string
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  // A calendar date (YYYY-MM-DD), never a timestamp.
  serviceDate: string
  clinicianFacilityAssignmentId: string
  facilityRegulatoryProfileId: string
  createdAt: string
  updatedAt: string
}

// The only fields A4.4 lets a client write. patientId comes from the route.
export type EncounterInput = {
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  serviceDate: string
}

export type EncounterPatch = Partial<EncounterInput>
