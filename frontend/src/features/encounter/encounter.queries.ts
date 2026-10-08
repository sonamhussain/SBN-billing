import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { contextKeys } from '../encounter-context/encounter-context.queries.ts'
import { createEncounter, getEncounter, listPatientEncounters, updateEncounter } from './encounter.api.ts'
import type { EncounterInput, EncounterPatch } from './encounter.types.ts'

// No optimistic writes: the server confirms and resolves the exact context first, then the cache is
// updated from its response and the dependent reads are refetched.

export const encounterKeys = {
  byPatient: (patientId: string) => ['encounters', patientId] as const,
  detail: (encounterId: string) => ['encounter', encounterId] as const,
}

// Callers pass an empty patientId until the Patient itself is accessible, so a missing or foreign
// Patient never triggers an Encounter request.
export function usePatientEncounters(patientId: string) {
  return useQuery({
    queryKey: encounterKeys.byPatient(patientId),
    queryFn: async () => (await listPatientEncounters(patientId)).items,
    enabled: patientId !== '',
  })
}

export function useEncounter(encounterId: string) {
  return useQuery({
    queryKey: encounterKeys.detail(encounterId),
    queryFn: () => getEncounter(encounterId),
    enabled: encounterId !== '',
  })
}

export function useCreateEncounter(patientId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: EncounterInput) => createEncounter(patientId, input),
    onSuccess: async (encounter) => {
      client.setQueryData(encounterKeys.detail(encounter.id), encounter)
      await client.invalidateQueries({ queryKey: encounterKeys.byPatient(patientId) })
    },
  })
}

export function useUpdateEncounter(patientId: string, encounterId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: EncounterPatch) => updateEncounter(encounterId, patch),
    onSuccess: async (encounter) => {
      client.setQueryData(encounterKeys.detail(encounterId), encounter)
      await Promise.all([
        client.invalidateQueries({ queryKey: encounterKeys.byPatient(patientId) }),
        client.invalidateQueries({ queryKey: contextKeys.detail(encounterId) }),
      ])
    },
  })
}
