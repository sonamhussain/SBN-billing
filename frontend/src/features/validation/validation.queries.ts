import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { readinessKeys } from '../readiness/readiness.queries.ts'
import { executeValidation, listRunFindings, listValidationRuns } from './validation.api.ts'

export const validationKeys = {
  byEncounter: (encounterId: string) => ['validation-runs', encounterId] as const,
  findings: (runId: string) => ['validation-findings', runId] as const,
}

export function useValidationRuns(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: validationKeys.byEncounter(encounterId),
    queryFn: async () => (await listValidationRuns(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

// A run's findings never change, so they stay cached in memory by the run's immutable id.
export function useRunFindings(runId: string, enabled: boolean) {
  return useQuery({
    queryKey: validationKeys.findings(runId),
    queryFn: async () => (await listRunFindings(runId)).items,
    enabled: enabled && runId !== '',
    staleTime: Infinity,
  })
}

// Running validation records one new immutable run. It refreshes the run and readiness histories only;
// it never records readiness itself.
export function useExecuteValidation(encounterId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => executeValidation(encounterId),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: validationKeys.byEncounter(encounterId) }),
        client.invalidateQueries({ queryKey: readinessKeys.byEncounter(encounterId) }),
      ]),
  })
}
