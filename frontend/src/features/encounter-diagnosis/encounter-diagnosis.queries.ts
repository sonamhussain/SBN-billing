import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { contextKeys } from '../encounter-context/encounter-context.queries.ts'
import { addEncounterDiagnosis, listEncounterDiagnoses, removeEncounterDiagnosis, reorderEncounterDiagnoses } from './encounter-diagnosis.api.ts'

// No optimistic writes. Reorder and remove return the server's new active list, which replaces the
// cached list; every mutation also refetches the billing context.

export const diagnosisKeys = {
  byEncounter: (encounterId: string) => ['encounter-diagnoses', encounterId] as const,
}

export function useEncounterDiagnoses(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: diagnosisKeys.byEncounter(encounterId),
    queryFn: async () => (await listEncounterDiagnoses(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

export function useDiagnosisMutations(encounterId: string) {
  const client = useQueryClient()
  const refreshContext = () => client.invalidateQueries({ queryKey: contextKeys.detail(encounterId) })

  const add = useMutation({
    mutationFn: (diagnosisCodeId: string) => addEncounterDiagnosis(encounterId, diagnosisCodeId),
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: diagnosisKeys.byEncounter(encounterId) }), refreshContext()])
    },
  })

  const reorder = useMutation({
    mutationFn: (encounterDiagnosisIds: string[]) => reorderEncounterDiagnoses(encounterId, encounterDiagnosisIds),
    onSuccess: async (result) => {
      client.setQueryData(diagnosisKeys.byEncounter(encounterId), result.items)
      await refreshContext()
    },
  })

  const remove = useMutation({
    mutationFn: (encounterDiagnosisId: string) => removeEncounterDiagnosis(encounterDiagnosisId),
    onSuccess: async (result) => {
      client.setQueryData(diagnosisKeys.byEncounter(encounterId), result.items)
      await refreshContext()
    },
  })

  return { add, reorder, remove }
}
