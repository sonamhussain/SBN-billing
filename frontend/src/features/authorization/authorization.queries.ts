import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addAuthorizationVersion,
  captureAuthorizationLines,
  evaluateAuthorizationScope,
  listAuthorizationLines,
  listAuthorizationVersions,
  listEncounterAuthorizations,
  recordAuthorization,
} from './authorization.api.ts'
import type { AuthorizationLineInput, AuthorizationVersionInput } from './authorization.types.ts'

// No optimistic writes. After a case, version or line set is recorded, only its owner queries refetch.

export const authorizationKeys = {
  byEncounter: (encounterId: string) => ['prior-authorizations', encounterId] as const,
  versions: (authorizationId: string) => ['prior-authorization-versions', authorizationId] as const,
  lines: (versionId: string) => ['authorization-lines', versionId] as const,
  scope: (versionId: string) => ['authorization-scope', versionId] as const,
}

export function useEncounterAuthorizations(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: authorizationKeys.byEncounter(encounterId),
    queryFn: async () => (await listEncounterAuthorizations(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

export function useAuthorizationVersions(authorizationId: string, enabled: boolean) {
  return useQuery({
    queryKey: authorizationKeys.versions(authorizationId),
    queryFn: async () => (await listAuthorizationVersions(authorizationId)).items,
    enabled: enabled && authorizationId !== '',
  })
}

export function useAuthorizationLines(versionId: string, enabled: boolean) {
  return useQuery({
    queryKey: authorizationKeys.lines(versionId),
    queryFn: async () => (await listAuthorizationLines(versionId)).items,
    enabled: enabled && versionId !== '',
  })
}

// Read-only and requested only when the user asks; a refusal is a final answer, so it is not retried.
export function useAuthorizationScope(versionId: string, enabled: boolean) {
  return useQuery({
    queryKey: authorizationKeys.scope(versionId),
    queryFn: () => evaluateAuthorizationScope(versionId),
    enabled: enabled && versionId !== '',
    retry: false,
  })
}

export function useRecordAuthorization(encounterId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: AuthorizationVersionInput) => recordAuthorization(encounterId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: authorizationKeys.byEncounter(encounterId) }),
  })
}

export function useAddAuthorizationVersion(encounterId: string, authorizationId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: AuthorizationVersionInput) => addAuthorizationVersion(authorizationId, input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: authorizationKeys.versions(authorizationId) }),
        client.invalidateQueries({ queryKey: authorizationKeys.byEncounter(encounterId) }),
      ]),
  })
}

export function useCaptureAuthorizationLines(versionId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (lines: AuthorizationLineInput[]) => captureAuthorizationLines(versionId, lines),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: authorizationKeys.lines(versionId) }),
        client.invalidateQueries({ queryKey: authorizationKeys.scope(versionId) }),
      ]),
  })
}
