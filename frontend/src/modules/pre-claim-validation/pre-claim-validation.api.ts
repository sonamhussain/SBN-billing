import { readApiError } from '../../shared/api-error.ts'

// A5.8 — the minimal developer-check client. One POST with an empty body: the server derives every
// context id, finding and outcome itself. Only the Encounter UUID appears in the path; nothing is
// logged and nothing is written to localStorage, sessionStorage or IndexedDB.

export type PreClaimValidationExecution = {
  validationRunId: string
  evaluatedAt: string
  validatorVersion: string
  findingCount: number
}

export async function executeValidation(encounterId: string): Promise<PreClaimValidationExecution> {
  const response = await fetch(`/api/encounters/${encounterId}/pre-claim-validation/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<PreClaimValidationExecution>
}
