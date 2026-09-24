import { readApiError } from '../../shared/api-error.ts'

// A4.4 — the minimal developer-check client. Encounter data travels only in request and response
// bodies: never in a URL query, never logged, never written to localStorage/sessionStorage.

export type Encounter = {
  id: string
  patientId: string
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  serviceDate: string
  clinicianFacilityAssignmentId: string
  facilityRegulatoryProfileId: string
  createdAt: string
  updatedAt: string
}

export type EncounterInput = {
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string
  serviceDate: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createEncounter(patientId: string, input: EncounterInput): Promise<Encounter> {
  return handle(
    await fetch(`/api/patients/${patientId}/encounters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        facilityId: input.facilityId,
        clinicianId: input.clinicianId,
        // A blank membership means self-pay / coverage not yet identified.
        insuranceMembershipId: input.insuranceMembershipId.trim() === '' ? null : input.insuranceMembershipId,
        serviceDate: input.serviceDate,
      }),
    }),
  )
}

export async function listEncounters(patientId: string): Promise<Encounter[]> {
  const body = await handle<{ items: Encounter[] }>(await fetch(`/api/patients/${patientId}/encounters`))
  return body.items
}

export async function getEncounter(id: string): Promise<Encounter> {
  return handle(await fetch(`/api/encounters/${id}`))
}

// Only the supplied field is sent; the server re-resolves the whole context.
export async function patchEncounter(id: string, patch: Record<string, string | null>): Promise<Encounter> {
  return handle(
    await fetch(`/api/encounters/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}
