import { readApiError } from '../../shared/api-error.ts'

// A4.9 — the minimal developer-check client. One read, no writes. The context is held in component
// state for the life of the view and nothing more: it is never logged, never put in a URL query and
// never written to localStorage, sessionStorage or IndexedDB. Only the Encounter UUID appears in
// the path, which is the one identifier the route needs.

// Only the fields the check actually displays are typed here. The response carries the full
// EncounterBillingContextV1; the check deliberately summarizes rather than dumping it.
export type BillingContextSummary = {
  schemaVersion: string
  assembledAt: string
  organizationId: string
  encounter: {
    id: string
    serviceDate: string
    clinicianFacilityAssignmentId: string
    facilityRegulatoryProfileId: string
  }
  patient: { id: string; displayName: string; dateOfBirth: string }
  facility: { id: string; name: string }
  clinician: { id: string; displayName: string }
  insuranceMembership: { id: string } | null
  providerContext: {
    clinicianFacilityAssignment: { id: string }
    facilityRegulatoryProfile: { id: string; jurisdictionCode: string; regulatoryAuthorityCode: string; status: string }
  }
  diagnoses: unknown[]
  activities: unknown[]
  observations: unknown[]
  externalIdentifiers: { patient: unknown[]; encounter: unknown[] }
}

export async function loadBillingContext(encounterId: string): Promise<BillingContextSummary> {
  const response = await fetch(`/api/encounters/${encounterId}/billing-context`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<BillingContextSummary>
}
