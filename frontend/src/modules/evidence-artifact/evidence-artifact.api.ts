import { readApiError } from '../../shared/api-error.ts'

// A5.1 — the minimal developer-check client.
//
// Evidence metadata travels only in request and response bodies. It is never placed in a URL query,
// never logged, and never written to localStorage, sessionStorage or IndexedDB. Only SBN UUIDs
// appear in a path. There is no upload, download or content call here, because A5.1 stores metadata
// about evidence held elsewhere and never transports the evidence itself.

export type EvidenceVersion = {
  id: string
  evidenceArtifactId: string
  version: number
  storageRef: string
  contentHash: string
  documentType: string
  sourceDate: string | null
  receivedAt: string
  createdByUserId: string
  createdAt: string
}

export type EvidenceArtifact = {
  id: string
  organizationId: string
  createdAt: string
  latestVersion: EvidenceVersion
}

export type EvidenceVersionInput = {
  storageRef: string
  contentHash: string
  documentType: string
  sourceDate: string | null
  receivedAt: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function createEvidenceArtifact(organizationId: string, input: EvidenceVersionInput): Promise<EvidenceArtifact> {
  return handle(await post(`/api/organizations/${organizationId}/evidence-artifacts`, input))
}

export async function listEvidenceArtifacts(organizationId: string): Promise<EvidenceArtifact[]> {
  const body = await handle<{ items: EvidenceArtifact[] }>(await fetch(`/api/organizations/${organizationId}/evidence-artifacts`))
  return body.items
}

export async function listEvidenceVersions(artifactId: string): Promise<EvidenceVersion[]> {
  const body = await handle<{ items: EvidenceVersion[] }>(await fetch(`/api/evidence-artifacts/${artifactId}/versions`))
  return body.items
}

// A correction is a new version, never an edit: there is deliberately no update or delete call.
export async function appendEvidenceVersion(artifactId: string, input: EvidenceVersionInput): Promise<EvidenceVersion> {
  return handle(await post(`/api/evidence-artifacts/${artifactId}/versions`, input))
}
