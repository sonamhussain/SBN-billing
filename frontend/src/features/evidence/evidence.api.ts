import { apiRequest } from '../../shared/api/client.ts'
import type { EncounterEvidenceLink, EvidenceArtifact, EvidenceArtifactVersion, EvidenceVersionInput } from './evidence.types.ts'

// FE-04 — real A5.1 and A5.6 routes only. Metadata travels in request bodies, never in a URL. There is
// no upload, download or content route, so none is called.

export function listOrganizationEvidence(organizationId: string) {
  return apiRequest<{ items: EvidenceArtifact[] }>(`/api/organizations/${organizationId}/evidence-artifacts`)
}

export function registerEvidence(organizationId: string, input: EvidenceVersionInput) {
  return apiRequest<EvidenceArtifact>(`/api/organizations/${organizationId}/evidence-artifacts`, { method: 'POST', body: JSON.stringify(input) })
}

export function listEvidenceVersions(artifactId: string) {
  return apiRequest<{ items: EvidenceArtifactVersion[] }>(`/api/evidence-artifacts/${artifactId}/versions`)
}

export function addEvidenceVersion(artifactId: string, input: EvidenceVersionInput) {
  return apiRequest<EvidenceArtifactVersion>(`/api/evidence-artifacts/${artifactId}/versions`, { method: 'POST', body: JSON.stringify(input) })
}

export function getEvidenceVersion(versionId: string) {
  return apiRequest<EvidenceArtifactVersion>(`/api/evidence-artifact-versions/${versionId}`)
}

export function listEncounterEvidenceLinks(encounterId: string) {
  return apiRequest<{ items: EncounterEvidenceLink[] }>(`/api/encounters/${encounterId}/evidence-links`)
}

export function linkEncounterEvidence(encounterId: string, evidenceArtifactVersionId: string) {
  return apiRequest<EncounterEvidenceLink>(`/api/encounters/${encounterId}/evidence-links`, {
    method: 'POST',
    body: JSON.stringify({ evidenceArtifactVersionId }),
  })
}

export function removeEncounterEvidenceLink(linkId: string) {
  return apiRequest<EncounterEvidenceLink>(`/api/encounter-evidence-links/${linkId}/remove`, { method: 'POST', body: '{}' })
}
