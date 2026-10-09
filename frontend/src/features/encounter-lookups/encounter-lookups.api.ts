import { apiRequest } from '../../shared/api/client.ts'

// FE-03 — read-only A2/A4.2 master reads the Encounter workspace needs for human-readable options and
// labels. Only existing routes: there is no organization-wide Facility list, so Facility names are read
// by ID from a Clinician's recorded facility assignments.

export type ClinicianOption = { id: string; displayName: string }
export type FacilityLabel = { id: string; name: string }
export type ServiceOption = { id: string; internalCode: string; displayName: string }
export type ProcedureCodeOption = {
  id: string
  internalCode: string
  displayName: string
  codeSystem: string | null
  externalCode: string | null
}
export type DiagnosisCodeOption = { id: string; code: string; displayName: string }

// A4.2 — a recorded period in which a Clinician practised at a Facility. A chooser aid only: the
// backend resolves the exact assignment for the service date.
export type ClinicianFacilityAssignment = {
  id: string
  clinicianId: string
  facilityId: string
  effectiveFrom: string
  effectiveTo: string | null
}

async function items<T>(path: string) {
  return (await apiRequest<{ items: T[] }>(path)).items
}

export const listClinicians = (organizationId: string) => items<ClinicianOption>(`/api/organizations/${organizationId}/clinicians`)
export const listServices = (organizationId: string) => items<ServiceOption>(`/api/organizations/${organizationId}/services`)
export const listProcedureCodes = (organizationId: string) =>
  items<ProcedureCodeOption>(`/api/organizations/${organizationId}/procedure-codes`)
export const listDiagnosisCodes = (organizationId: string) =>
  items<DiagnosisCodeOption>(`/api/organizations/${organizationId}/diagnosis-codes`)
export const listFacilityAssignments = (clinicianId: string) =>
  items<ClinicianFacilityAssignment>(`/api/clinicians/${clinicianId}/facility-assignments`)

export const getClinician = (id: string) => apiRequest<ClinicianOption>(`/api/clinicians/${id}`)
export const getFacility = (id: string) => apiRequest<FacilityLabel>(`/api/facilities/${id}`)
export const getService = (id: string) => apiRequest<ServiceOption>(`/api/services/${id}`)
export const getProcedureCode = (id: string) => apiRequest<ProcedureCodeOption>(`/api/procedure-codes/${id}`)
export const getDiagnosisCode = (id: string) => apiRequest<DiagnosisCodeOption>(`/api/diagnosis-codes/${id}`)
