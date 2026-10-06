import { readApiError } from '../../shared/api-error.ts'

// A5.7 — the minimal read-only developer-check client.
//
// GET requests only: there is no create, execute, update or delete call, because A5.7 has no such
// route. Only SBN UUIDs appear in a path and nothing travels in a query string. Nothing is logged and
// nothing is written to localStorage, sessionStorage or IndexedDB.

export type ValidationRunSummary = {
  id: string
  encounterId: string
  evaluatedAt: string
  validatorVersion: string
  findingCount: number
}

export type ValidationFindingSummary = {
  id: string
  sequence: number
  layer: string
  outcome: string
  findingCode: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function listRuns(encounterId: string) {
  return handle<{ items: ValidationRunSummary[] }>(await fetch(`/api/encounters/${encounterId}/validation-runs`))
}

export async function listFindings(runId: string) {
  return handle<{ items: ValidationFindingSummary[] }>(await fetch(`/api/validation-runs/${runId}/findings`))
}
