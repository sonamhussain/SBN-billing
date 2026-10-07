import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { contextKeys } from '../encounter-context/encounter-context.queries.ts'
import { createEncounterActivity, listEncounterActivities, removeEncounterActivity } from './encounter-activity.api.ts'
import type { EncounterActivityInput } from './encounter-activity.types.ts'

// No optimistic writes: the active list and the billing context are refetched after the server confirms.

export const activityKeys = {
  byEncounter: (encounterId: string) => ['encounter-activities', encounterId] as const,
}

export function useEncounterActivities(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: activityKeys.byEncounter(encounterId),
    queryFn: async () => (await listEncounterActivities(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

export function useActivityMutations(encounterId: string) {
  const client = useQueryClient()
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: activityKeys.byEncounter(encounterId) }),
      client.invalidateQueries({ queryKey: contextKeys.detail(encounterId) }),
    ])

  const create = useMutation({
    mutationFn: (input: EncounterActivityInput) => createEncounterActivity(encounterId, input),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: (encounterActivityId: string) => removeEncounterActivity(encounterActivityId),
    onSuccess: refresh,
  })

  return { create, remove }
}
