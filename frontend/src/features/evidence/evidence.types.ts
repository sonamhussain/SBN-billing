// FE-04 — the A5.1 evidence contract. Evidence is metadata only: an opaque storage reference supplied by
// the real storage/manual workflow, a SHA-256 content hash, a document type and dates. There is no file
// transport. Artifacts and versions are immutable; a new representation is a new version.
export type EvidenceArtifactVersion = {
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
  latestVersion: EvidenceArtifactVersion
}

export type EvidenceVersionInput = {
  storageRef: string
  contentHash: string
  documentType: string
  sourceDate: string | null
  // An ISO-8601 instant.
  receivedAt: string
}

// A5.6 — one exact evidence version linked to an Encounter. Removal is one-way and keeps history.
export type EncounterEvidenceLink = {
  id: string
  encounterId: string
  evidenceArtifactVersionId: string
  removedAt: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
}
