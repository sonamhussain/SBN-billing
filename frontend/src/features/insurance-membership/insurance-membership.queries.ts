import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createMembership, listMemberships, updateMembership } from './insurance-membership.api.ts'
import type { InsuranceMembershipCreateInput, InsuranceMembershipPatch } from './insurance-membership.types.ts'

// No optimistic writes: the Patient's membership list is refetched after the server confirms.

export const membershipKeys = {
  byPatient: (patientId: string) => ['insurance-memberships', patientId] as const,
}

export function useMemberships(patientId: string) {
  return useQuery({
    queryKey: membershipKeys.byPatient(patientId),
    queryFn: async () => (await listMemberships(patientId)).items,
    enabled: patientId !== '',
  })
}

export function useCreateMembership(patientId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: InsuranceMembershipCreateInput) => createMembership(patientId, input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: membershipKeys.byPatient(patientId) })
    },
  })
}

export function useUpdateMembership(patientId: string, membershipId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: InsuranceMembershipPatch) => updateMembership(membershipId, patch),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: membershipKeys.byPatient(patientId) })
    },
  })
}
