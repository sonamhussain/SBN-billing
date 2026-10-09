import { apiRequest } from '../../shared/api/client.ts'
import type { CompletenessTarget, EvidenceCompletenessEvaluation } from './evidence-completeness.types.ts'

// FE-04 — the explicit A5.6 completeness evaluation. It records nothing; the body carries only the optional
// activity or diagnosis target.
export function evaluateEvidenceCompleteness(encounterId: string, target: CompletenessTarget) {
  return apiRequest<EvidenceCompletenessEvaluation>(`/api/encounters/${encounterId}/evidence-completeness/evaluate`, {
    method: 'POST',
    body: JSON.stringify(target),
  })
}
