import { apiRequest } from '../../shared/api/client.ts'
import type { Encounter, EncounterInput, EncounterPatch } from './encounter.types.ts'

// FE-03 — real A4.4 endpoints only. The backend has no organization-wide Encounter list and no
// Encounter delete; neither is invented here.

export function listPatientEncounters(patientId: string) {
  return apiRequest<{ items: Encounter[] }>(`/api/patients/${patientId}/encounters`)
}

export function getEncounter(encounterId: string) {
  return apiRequest<Encounter>(`/api/encounters/${encounterId}`)
}

export function createEncounter(patientId: string, input: EncounterInput) {
  return apiRequest<Encounter>(`/api/patients/${patientId}/encounters`, { method: 'POST', body: JSON.stringify(input) })
}

export function updateEncounter(encounterId: string, patch: EncounterPatch) {
  return apiRequest<Encounter>(`/api/encounters/${encounterId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}
