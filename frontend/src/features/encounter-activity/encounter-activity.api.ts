import { apiRequest } from '../../shared/api/client.ts'
import type { EncounterActivity, EncounterActivityInput } from './encounter-activity.types.ts'

// FE-03 — real A4.6 routes only. There is no activity PATCH; removal keeps history.

export function listEncounterActivities(encounterId: string) {
  return apiRequest<{ items: EncounterActivity[] }>(`/api/encounters/${encounterId}/activities`)
}

export function createEncounterActivity(encounterId: string, input: EncounterActivityInput) {
  return apiRequest<EncounterActivity>(`/api/encounters/${encounterId}/activities`, { method: 'POST', body: JSON.stringify(input) })
}

export function removeEncounterActivity(encounterActivityId: string) {
  return apiRequest<EncounterActivity>(`/api/encounter-activities/${encounterActivityId}/remove`, { method: 'POST', body: '{}' })
}
