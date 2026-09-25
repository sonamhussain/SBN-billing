import { readApiError } from '../../shared/api-error.ts'

// A4.6 — the minimal developer-check client. Activity data travels only in request and response
// bodies: never in a URL query, never logged, never written to localStorage/sessionStorage.

export type EncounterActivity = {
  id: string
  encounterId: string
  serviceId: string | null
  procedureCodeId: string | null
  // Exact decimal string from the server; never parsed into a float here.
  quantity: string
  unitCode: string | null
  modifierCodes: string[]
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type NewEncounterActivity = {
  serviceId: string | null
  procedureCodeId: string | null
  quantity: string
  unitCode: string | null
  modifierCodes: string[]
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

export async function addActivity(encounterId: string, activity: NewEncounterActivity): Promise<EncounterActivity> {
  return handle(await fetch(`/api/encounters/${encounterId}/activities`, jsonInit('POST', activity)))
}

// Active activities only, in display order (not a claim-line order).
export async function listActivities(encounterId: string): Promise<EncounterActivity[]> {
  const body = await handle<{ items: EncounterActivity[] }>(await fetch(`/api/encounters/${encounterId}/activities`))
  return body.items
}

// Marks the activity removed (its facts and modifiers are kept as history) and returns it.
export async function removeActivity(id: string): Promise<EncounterActivity> {
  return handle(await fetch(`/api/encounter-activities/${id}/remove`, jsonInit('POST', {})))
}
