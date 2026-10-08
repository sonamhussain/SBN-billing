import { apiRequest } from '../../shared/api/client.ts'
import type { EligibilityVerification, EligibilityVerificationInput } from './eligibility.types.ts'

// FE-04 — real A5.2 routes only. Recording a verification sends nothing to a payer; it stores a result
// that was already obtained. There is no update or delete.

export function listEligibilityVerifications(encounterId: string) {
  return apiRequest<{ items: EligibilityVerification[] }>(`/api/encounters/${encounterId}/eligibility-verifications`)
}

export function recordEligibilityVerification(encounterId: string, input: EligibilityVerificationInput) {
  return apiRequest<EligibilityVerification>(`/api/encounters/${encounterId}/eligibility-verifications`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
