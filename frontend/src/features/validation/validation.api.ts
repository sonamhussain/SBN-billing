import { apiRequest } from '../../shared/api/client.ts'
import type { ValidationExecution, ValidationFinding, ValidationRun } from './validation.types.ts'

// FE-04 — A5.7 history reads and the single A5.8 execute entry. Execute sends an empty body: the client
// supplies no layer, outcome, rule, evidence or commercial id.

export function listValidationRuns(encounterId: string) {
  return apiRequest<{ items: ValidationRun[] }>(`/api/encounters/${encounterId}/validation-runs`)
}

export function listRunFindings(runId: string) {
  return apiRequest<{ items: ValidationFinding[] }>(`/api/validation-runs/${runId}/findings`)
}

export function executeValidation(encounterId: string) {
  return apiRequest<ValidationExecution>(`/api/encounters/${encounterId}/pre-claim-validation/execute`, { method: 'POST', body: '{}' })
}
