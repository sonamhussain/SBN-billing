import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { contextKeys } from '../encounter-context/encounter-context.queries.ts'
import { createEncounterObservation, listEncounterObservations, removeEncounterObservation } from './encounter-observation.api.ts'
import type { EncounterObservationInput } from './encounter-observation.types.ts'

// No optimistic writes: the active list and the billing context are refetched after the server confirms.

export const observationKeys = {
  byEncounter: (encounterId: string) => ['encounter-observations', encounterId] as const,
}

export function useEncounterObservations(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: observationKeys.byEncounter(encounterId),
    queryFn: async () => (await listEncounterObservations(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

export function useObservationMutations(encounterId: string) {
  const client = useQueryClient()
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: observationKeys.byEncounter(encounterId) }),
      client.invalidateQueries({ queryKey: contextKeys.detail(encounterId) }),
    ])

  const create = useMutation({
    mutationFn: (input: EncounterObservationInput) => createEncounterObservation(encounterId, input),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: (encounterObservationId: string) => removeEncounterObservation(encounterObservationId),
    onSuccess: refresh,
  })

  return { create, remove }
}
