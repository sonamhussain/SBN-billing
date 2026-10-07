import { apiRequest } from '../../shared/api/client.ts'
import type { Patient, PatientCreateInput, PatientPatch } from './patient.types.ts'

// FE-02 — real A4.1 endpoints only, through the FE-01 HTTP boundary. No search route exists in the
// backend, so none is invented here.

export function listPatients(organizationId: string) {
  return apiRequest<{ items: Patient[] }>(`/api/organizations/${organizationId}/patients`)
}

export function getPatient(patientId: string) {
  return apiRequest<Patient>(`/api/patients/${patientId}`)
}

export function createPatient(organizationId: string, input: PatientCreateInput) {
  return apiRequest<Patient>(`/api/organizations/${organizationId}/patients`, { method: 'POST', body: JSON.stringify(input) })
}

export function updatePatient(patientId: string, patch: PatientPatch) {
  return apiRequest<Patient>(`/api/patients/${patientId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}
