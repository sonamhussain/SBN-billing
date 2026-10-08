import { useQueries, useQuery } from '@tanstack/react-query'
import { usePermission } from '../../shared/auth/usePermission.ts'
import {
  getClinician,
  getFacility,
  getProcedureCode,
  getService,
  listClinicians,
  listDiagnosisCodes,
  listFacilityAssignments,
  listProcedureCodes,
  listServices,
} from './encounter-lookups.api.ts'

// FE-03 — option lists load only while a form needs them (`enabled`) and only when the user holds the
// read permission, so a missing permission shows "unavailable" instead of a request that must fail.
// Row labels are read by ID and cached, so a list never pulls a whole master just to show a few names.
// Nothing here is persisted to browser storage.

const MASTER_STALE_MS = 5 * 60_000

function useMasterList<T>(organizationId: string, kind: string, permission: string, enabled: boolean, load: (organizationId: string) => Promise<T[]>) {
  const permitted = usePermission().can(permission)
  const query = useQuery({
    queryKey: ['encounter-lookup', organizationId, kind] as const,
    queryFn: () => load(organizationId),
    enabled: enabled && permitted && organizationId !== '',
    staleTime: MASTER_STALE_MS,
  })
  return { ...query, permitted }
}

export const useClinicianOptions = (organizationId: string, enabled: boolean) =>
  useMasterList(organizationId, 'clinicians', 'clinician.read', enabled, listClinicians)
export const useServiceOptions = (organizationId: string, enabled: boolean) =>
  useMasterList(organizationId, 'services', 'service.read', enabled, listServices)
export const useProcedureCodeOptions = (organizationId: string, enabled: boolean) =>
  useMasterList(organizationId, 'procedure-codes', 'procedure_code.read', enabled, listProcedureCodes)
export const useDiagnosisCodeOptions = (organizationId: string, enabled: boolean) =>
  useMasterList(organizationId, 'diagnosis-codes', 'diagnosisCode.read', enabled, listDiagnosisCodes)

export function useFacilityAssignments(clinicianId: string) {
  const permitted = usePermission().can('clinicianAssignment.read')
  const query = useQuery({
    queryKey: ['clinician-facility-assignments', clinicianId] as const,
    queryFn: () => listFacilityAssignments(clinicianId),
    enabled: permitted && clinicianId !== '',
  })
  return { ...query, permitted }
}

// A label is a display aid only. It never falls back to a raw identifier.
function useLabel(kind: string, id: string | null, permission: string, load: (id: string) => Promise<string>) {
  const permitted = usePermission().can(permission)
  const query = useQuery({
    queryKey: ['encounter-label', kind, id] as const,
    queryFn: () => load(id as string),
    enabled: permitted && id !== null && id !== '',
    staleTime: MASTER_STALE_MS,
  })
  if (id === null || id === '') return null
  if (!permitted || query.isError) return 'Unavailable'
  return query.data ?? 'Loading...'
}

// Names for several Facilities at once (a Clinician's recorded assignments), sharing the per-ID cache.
export function useFacilityNames(ids: readonly string[]) {
  const permitted = usePermission().can('facility.read')
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['encounter-label', 'facility', id] as const,
      queryFn: async () => (await getFacility(id)).name,
      enabled: permitted,
      staleTime: MASTER_STALE_MS,
    })),
  })
  const names = new Map(ids.map((id, index) => [id, results[index]?.data]))
  return {
    names,
    loading: permitted && results.some((result) => result.isPending),
    unavailable: !permitted || results.some((result) => result.isError),
  }
}

export const useClinicianName = (id: string | null) =>
  useLabel('clinician', id, 'clinician.read', async (value) => (await getClinician(value)).displayName)
export const useFacilityName = (id: string | null) =>
  useLabel('facility', id, 'facility.read', async (value) => (await getFacility(value)).name)
export const useServiceName = (id: string | null) =>
  useLabel('service', id, 'service.read', async (value) => {
    const service = await getService(value)
    return `${service.internalCode} — ${service.displayName}`
  })
export const useProcedureCodeName = (id: string | null) =>
  useLabel('procedure-code', id, 'procedure_code.read', async (value) => {
    const procedure = await getProcedureCode(value)
    return `${procedure.internalCode} — ${procedure.displayName}`
  })
