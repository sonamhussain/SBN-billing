import { apiRequest } from '../../shared/api/client.ts'
import type { EncounterObservation, EncounterObservationInput } from './encounter-observation.types.ts'

// FE-03 — real A4.7 routes only. There is no observation PATCH; removal keeps history.

export function listEncounterObservations(encounterId: string) {
  return apiRequest<{ items: EncounterObservation[] }>(`/api/encounters/${encounterId}/observations`)
}

export function createEncounterObservation(encounterId: string, input: EncounterObservationInput) {
  return apiRequest<EncounterObservation>(`/api/encounters/${encounterId}/observations`, { method: 'POST', body: JSON.stringify(input) })
}

export function removeEncounterObservation(encounterObservationId: string) {
  return apiRequest<EncounterObservation>(`/api/encounter-observations/${encounterObservationId}/remove`, { method: 'POST', body: '{}' })
}
