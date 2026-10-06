import { readApiError } from '../../shared/api-error.ts'

// A4.7 — the minimal developer-check client. Observation facts travel only in request and response
// bodies: never in a URL query, never logged, never written to localStorage/sessionStorage.

export type ObservationValue =
  | { type: 'TEXT'; text: string }
  | { type: 'DECIMAL'; decimal: string; unitCode?: string | null }
  | { type: 'BOOLEAN'; boolean: boolean }
  | { type: 'DATE'; date: string }

export type EncounterObservation = {
  id: string
  encounterId: string
  encounterActivityId: string | null
  factKey: string
  value: ObservationValue
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type NewEncounterObservation = {
  encounterActivityId: string | null
  factKey: string
  value: ObservationValue
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.code}: ${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export async function addObservation(encounterId: string, observation: NewEncounterObservation): Promise<EncounterObservation> {
  return handle(await fetch(`/api/encounters/${encounterId}/observations`, jsonInit('POST', observation)))
}

// Active observations only, in display order (not a clinical or claim order).
export async function listObservations(encounterId: string): Promise<EncounterObservation[]> {
  const body = await handle<{ items: EncounterObservation[] }>(await fetch(`/api/encounters/${encounterId}/observations`))
  return body.items
}

// Marks the observation removed (the fact is kept as history) and returns it.
export async function removeObservation(id: string): Promise<EncounterObservation> {
  return handle(await fetch(`/api/encounter-observations/${id}/remove`, jsonInit('POST', {})))
}
