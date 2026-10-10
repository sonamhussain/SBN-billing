import { readApiError } from '../../shared/api-error.ts'

// A6.1 — the minimal developer-check client. One POST with an empty body (the server derives the
// Encounter, contract and handoff versions, creator and time itself) and two GETs. Only SBN UUIDs
// appear in a path and nothing travels in a query string. Nothing is logged and nothing is written to
// localStorage, sessionStorage or IndexedDB.

export type ClaimSummary = {
  id: string
  encounterId: string
  preClaimReadinessAssessmentId: string
  claimContractVersion: string
  handoffSchemaVersion: string
  createdAt: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createClaim(assessmentId: string) {
  return handle<ClaimSummary>(
    await fetch(`/api/pre-claim-readiness-assessments/${assessmentId}/claims`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  )
}

export async function readClaim(claimId: string) {
  return handle<ClaimSummary>(await fetch(`/api/claims/${claimId}`))
}

export async function listEncounterClaims(encounterId: string) {
  return handle<{ items: ClaimSummary[] }>(await fetch(`/api/encounters/${encounterId}/claims`))
}
