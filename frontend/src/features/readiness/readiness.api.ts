import { apiRequest } from '../../shared/api/client.ts'
import type { PreClaimA6Handoff, ReadinessAssessment, ReadinessAssessmentDetail } from './readiness.types.ts'

// FE-04 — real A5.9 routes only. Recording readiness targets one exact validation run with an empty body.

export function listEncounterReadiness(encounterId: string) {
  return apiRequest<{ items: ReadinessAssessment[] }>(`/api/encounters/${encounterId}/pre-claim-readiness-assessments`)
}

export function getReadinessAssessment(assessmentId: string) {
  return apiRequest<ReadinessAssessmentDetail>(`/api/pre-claim-readiness-assessments/${assessmentId}`)
}

export function recordReadiness(validationRunId: string) {
  return apiRequest<ReadinessAssessment>(`/api/validation-runs/${validationRunId}/readiness-assessments`, { method: 'POST', body: '{}' })
}

export function getA6Handoff(assessmentId: string) {
  return apiRequest<PreClaimA6Handoff>(`/api/pre-claim-readiness-assessments/${assessmentId}/a6-handoff`)
}
