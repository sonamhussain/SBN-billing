import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getA6Handoff, getReadinessAssessment, listEncounterReadiness, recordReadiness } from './readiness.api.ts'

export const readinessKeys = {
  byEncounter: (encounterId: string) => ['readiness-assessments', encounterId] as const,
  detail: (assessmentId: string) => ['readiness-assessment', assessmentId] as const,
  handoff: (assessmentId: string) => ['a6-handoff', assessmentId] as const,
}

export function useEncounterReadiness(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: readinessKeys.byEncounter(encounterId),
    queryFn: async () => (await listEncounterReadiness(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

// An assessment never changes, so its detail stays cached in memory by its immutable id.
export function useReadinessDetail(assessmentId: string, enabled: boolean) {
  return useQuery({
    queryKey: readinessKeys.detail(assessmentId),
    queryFn: () => getReadinessAssessment(assessmentId),
    enabled: enabled && assessmentId !== '',
    staleTime: Infinity,
  })
}

// The handoff is re-read each time it is opened: a newer validation run makes the backend refuse an older
// READY assessment, and that refusal must be shown rather than an earlier cached answer.
export function useA6Handoff(assessmentId: string, enabled: boolean) {
  return useQuery({
    queryKey: readinessKeys.handoff(assessmentId),
    queryFn: () => getA6Handoff(assessmentId),
    enabled: enabled && assessmentId !== '',
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
}

// Records one assessment for one exact run. It never re-runs validation.
export function useRecordReadiness(encounterId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (validationRunId: string) => recordReadiness(validationRunId),
    onSuccess: () => client.invalidateQueries({ queryKey: readinessKeys.byEncounter(encounterId) }),
  })
}
