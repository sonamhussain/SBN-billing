import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listEligibilityVerifications, recordEligibilityVerification } from './eligibility.api.ts'
import type { EligibilityVerificationInput } from './eligibility.types.ts'

// No optimistic writes: a new verification appears only after the server records it.

export const eligibilityKeys = {
  byEncounter: (encounterId: string) => ['eligibility-verifications', encounterId] as const,
}

export function useEligibilityVerifications(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: eligibilityKeys.byEncounter(encounterId),
    queryFn: async () => (await listEligibilityVerifications(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

export function useRecordEligibilityVerification(encounterId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: EligibilityVerificationInput) => recordEligibilityVerification(encounterId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: eligibilityKeys.byEncounter(encounterId) }),
  })
}
