import { apiRequest } from '../../shared/api/client.ts'
import type { EncounterDiagnosis } from './encounter-diagnosis.types.ts'

// FE-03 — real A4.5 routes only. Removal goes through the remove route (history is kept); there is no
// delete or restore.

type DiagnosisList = { items: EncounterDiagnosis[] }

export function listEncounterDiagnoses(encounterId: string) {
  return apiRequest<DiagnosisList>(`/api/encounters/${encounterId}/diagnoses`)
}

export function addEncounterDiagnosis(encounterId: string, diagnosisCodeId: string) {
  return apiRequest<EncounterDiagnosis>(`/api/encounters/${encounterId}/diagnoses`, { method: 'POST', body: JSON.stringify({ diagnosisCodeId }) })
}

// The complete active ID set in the new order.
export function reorderEncounterDiagnoses(encounterId: string, encounterDiagnosisIds: string[]) {
  return apiRequest<DiagnosisList>(`/api/encounters/${encounterId}/diagnoses/order`, {
    method: 'PUT',
    body: JSON.stringify({ encounterDiagnosisIds }),
  })
}

export function removeEncounterDiagnosis(encounterDiagnosisId: string) {
  return apiRequest<DiagnosisList>(`/api/encounter-diagnoses/${encounterDiagnosisId}/remove`, { method: 'POST', body: '{}' })
}
