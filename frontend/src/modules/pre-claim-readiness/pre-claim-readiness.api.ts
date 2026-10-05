import { readApiError } from '../../shared/api-error.ts'

// A5.9 — the minimal developer-check client. One POST with an empty body (the server derives the
// policy, state and time itself) and two GETs. Only SBN UUIDs appear in a path and nothing travels in
// a query string. Nothing is logged and nothing is written to localStorage, sessionStorage or
// IndexedDB. The handoff response is reduced to counts here; its reference ids are never kept.

export type ReadinessAssessmentSummary = {
  id: string
  validationRunId: string
  readinessPolicyVersion: string
  state: string
  assessedAt: string
}

export type HandoffCounts = { total: number; pass: number; warning: number; restrict: number; fail: number }

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function recordAssessment(validationRunId: string) {
  return handle<ReadinessAssessmentSummary>(
    await fetch(`/api/validation-runs/${validationRunId}/readiness-assessments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  )
}

export async function listAssessments(encounterId: string) {
  return handle<{ items: ReadinessAssessmentSummary[] }>(await fetch(`/api/encounters/${encounterId}/pre-claim-readiness-assessments`))
}

export async function readHandoffCounts(assessmentId: string): Promise<HandoffCounts> {
  const handoff = await handle<{ findingSummary: HandoffCounts }>(await fetch(`/api/pre-claim-readiness-assessments/${assessmentId}/a6-handoff`))
  const { total, pass, warning, restrict, fail } = handoff.findingSummary
  return { total, pass, warning, restrict, fail }
}
