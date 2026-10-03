import { readApiError } from '../../shared/api-error.ts'

// A5.6 — the minimal developer-check client.
//
// Only SBN UUIDs appear in a path; the optional target travels in a request body, never a query
// string. Nothing is logged and nothing is written to localStorage, sessionStorage or IndexedDB.
// There is no upload or download call: A5.1 remains the storage owner.

export type RequirementCompleteness = {
  evidenceRequirementId: string
  ruleVersionId: string
  state: 'SATISFIED' | 'MISSING' | 'INCOMPLETE'
  minimumCount: number
  validCount: number
  invalidCount: number
  staleCount: number
  totalCandidateCount: number
}

export type EvidenceCompletenessEvaluation = {
  schemaVersion: 'EvidenceCompletenessEvaluationV1'
  evaluatedAt: string
  encounterId: string
  businessDate: string
  requirements: RequirementCompleteness[]
}

export class EvaluationRefused extends Error {
  readonly reason: string | undefined
  constructor(message: string, reason: string | undefined) {
    super(message)
    this.reason = reason
  }
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new EvaluationRefused(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`, apiError.reason)
  }
  return response.json() as Promise<T>
}

export async function linkEvidence(encounterId: string, evidenceArtifactVersionId: string): Promise<{ id: string }> {
  return handle(
    await fetch(`/api/encounters/${encounterId}/evidence-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceArtifactVersionId }),
    }),
  )
}

// A read, sent as POST so the optional target stays out of the URL. Nothing is stored or audited.
export async function evaluateCompleteness(encounterId: string, target: { encounterActivityId: string | null; encounterDiagnosisId: string | null }) {
  return handle<EvidenceCompletenessEvaluation>(
    await fetch(`/api/encounters/${encounterId}/evidence-completeness/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    }),
  )
}
