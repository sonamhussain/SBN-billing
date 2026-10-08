import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePermission } from '../../shared/auth/usePermission.ts'
import {
  addEvidenceVersion,
  getEvidenceVersion,
  linkEncounterEvidence,
  listEncounterEvidenceLinks,
  listEvidenceVersions,
  listOrganizationEvidence,
  registerEvidence,
  removeEncounterEvidenceLink,
} from './evidence.api.ts'
import type { EvidenceVersionInput } from './evidence.types.ts'

// No optimistic writes: evidence history changes only after the server confirms. Metadata lives in the
// in-memory query cache only and is never persisted or logged.

export const evidenceKeys = {
  byOrganization: (organizationId: string) => ['evidence-artifacts', organizationId] as const,
  versions: (artifactId: string) => ['evidence-artifact-versions', artifactId] as const,
  version: (versionId: string) => ['evidence-artifact-version', versionId] as const,
  encounterLinks: (encounterId: string) => ['encounter-evidence-links', encounterId] as const,
}

// The organization's registered evidence; loaded only while a chooser needs it.
export function useOrganizationEvidence(organizationId: string, enabled: boolean) {
  const permitted = usePermission().can('evidenceArtifact.read')
  const query = useQuery({
    queryKey: evidenceKeys.byOrganization(organizationId),
    queryFn: async () => (await listOrganizationEvidence(organizationId)).items,
    enabled: enabled && permitted && organizationId !== '',
  })
  return { ...query, permitted }
}

export function useEvidenceVersions(artifactId: string) {
  return useQuery({
    queryKey: evidenceKeys.versions(artifactId),
    queryFn: async () => (await listEvidenceVersions(artifactId)).items,
    enabled: artifactId !== '',
  })
}

// One exact version's metadata, cached by its immutable id.
export function useEvidenceVersion(versionId: string | null) {
  const permitted = usePermission().can('evidenceArtifact.read')
  const query = useQuery({
    queryKey: evidenceKeys.version(versionId ?? ''),
    queryFn: () => getEvidenceVersion(versionId as string),
    enabled: permitted && versionId !== null && versionId !== '',
    staleTime: Infinity,
  })
  return { ...query, permitted }
}

export function useEncounterEvidenceLinks(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: evidenceKeys.encounterLinks(encounterId),
    queryFn: async () => (await listEncounterEvidenceLinks(encounterId)).items,
    enabled: enabled && encounterId !== '',
  })
}

export function useRegisterEvidence(organizationId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: EvidenceVersionInput) => registerEvidence(organizationId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: evidenceKeys.byOrganization(organizationId) }),
  })
}

export function useAddEvidenceVersion(organizationId: string, artifactId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: EvidenceVersionInput) => addEvidenceVersion(artifactId, input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: evidenceKeys.versions(artifactId) }),
        client.invalidateQueries({ queryKey: evidenceKeys.byOrganization(organizationId) }),
      ]),
  })
}

// Linking or removing evidence changes only the Encounter's link list. Completeness is an explicit
// evaluation the user runs again; nothing is re-evaluated automatically.
export function useEvidenceLinkMutations(encounterId: string) {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: evidenceKeys.encounterLinks(encounterId) })
  const link = useMutation({ mutationFn: (versionId: string) => linkEncounterEvidence(encounterId, versionId), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (linkId: string) => removeEncounterEvidenceLink(linkId), onSuccess: refresh })
  return { link, remove }
}
