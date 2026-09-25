import { readApiError } from '../../shared/api-error.ts'

// A4.5 — the minimal developer-check client. Diagnosis data travels only in request and response
// bodies: never in a URL query, never logged, never written to localStorage/sessionStorage.

export type EncounterDiagnosis = {
  id: string
  encounterId: string
  diagnosisCodeId: string
  sequence: number
  diagnosisCode: { code: string; displayName: string }
  createdAt: string
  updatedAt: string
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

export async function addDiagnosis(encounterId: string, diagnosisCodeId: string): Promise<EncounterDiagnosis> {
  return handle(await fetch(`/api/encounters/${encounterId}/diagnoses`, jsonInit('POST', { diagnosisCodeId })))
}

export async function listDiagnoses(encounterId: string): Promise<EncounterDiagnosis[]> {
  const body = await handle<{ items: EncounterDiagnosis[] }>(await fetch(`/api/encounters/${encounterId}/diagnoses`))
  return body.items
}

// The full active list in its new order; the server rewrites every position atomically.
export async function reorderDiagnoses(encounterId: string, encounterDiagnosisIds: string[]): Promise<EncounterDiagnosis[]> {
  const body = await handle<{ items: EncounterDiagnosis[] }>(
    await fetch(`/api/encounters/${encounterId}/diagnoses/order`, jsonInit('PUT', { encounterDiagnosisIds })),
  )
  return body.items
}

// Marks the row removed (history is kept) and returns the compacted active list.
export async function removeDiagnosis(id: string): Promise<EncounterDiagnosis[]> {
  const body = await handle<{ items: EncounterDiagnosis[] }>(await fetch(`/api/encounter-diagnoses/${id}/remove`, jsonInit('POST', {})))
  return body.items
}
