import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createPatient, getPatient, listPatients, updatePatient } from './patient.api.ts'
import type { PatientCreateInput, PatientPatch } from './patient.types.ts'

// No optimistic writes: the server confirms first, then the cache is updated and the list refetched.

export const patientKeys = {
  all: (organizationId: string) => ['patients', organizationId] as const,
  detail: (patientId: string) => ['patient', patientId] as const,
}

export function usePatients(organizationId: string) {
  return useQuery({
    queryKey: patientKeys.all(organizationId),
    queryFn: async () => (await listPatients(organizationId)).items,
  })
}

export function usePatient(patientId: string) {
  return useQuery({
    queryKey: patientKeys.detail(patientId),
    queryFn: () => getPatient(patientId),
    enabled: patientId !== '',
  })
}

export function useCreatePatient(organizationId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: PatientCreateInput) => createPatient(organizationId, input),
    onSuccess: async (patient) => {
      client.setQueryData(patientKeys.detail(patient.id), patient)
      await client.invalidateQueries({ queryKey: patientKeys.all(organizationId) })
    },
  })
}

export function useUpdatePatient(organizationId: string, patientId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: PatientPatch) => updatePatient(patientId, patch),
    onSuccess: async (patient) => {
      client.setQueryData(patientKeys.detail(patientId), patient)
      await client.invalidateQueries({ queryKey: patientKeys.all(organizationId) })
    },
  })
}
