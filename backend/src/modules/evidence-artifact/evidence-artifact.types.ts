// A5.1 — EvidenceArtifact is a stable organization-owned identity for one piece of evidence, and
// EvidenceArtifactVersion is the immutable metadata of one exact representation that was received
// and stored for it. Neither carries document content: the bytes live outside this system and are
// named only by an opaque storage reference.
//
// A5.1 makes no eligibility, authorization, completeness, validation, readiness, claim, pricing or
// submission decision. Later records point at exact version ids; they do not add columns here.

export type EvidenceArtifactVersionDto = {
  id: string
  evidenceArtifactId: string
  // Server-owned, gap-free per artifact, starting at 1.
  version: number
  // An opaque locator. It is never a path, URL, bucket key or signed download link.
  storageRef: string
  // Canonical lowercase 64-character SHA-256 digest of the stored representation.
  contentHash: string
  documentType: string
  // A calendar date (YYYY-MM-DD), or null when the source date is genuinely unknown. It is never
  // inferred from receivedAt.
  sourceDate: string | null
  receivedAt: string
  createdByUserId: string
  createdAt: string
}

export type EvidenceArtifactDto = {
  id: string
  organizationId: string
  createdAt: string
  // Every artifact has at least one version, so this is never null: an artifact cannot exist
  // without the representation that brought it into being.
  latestVersion: EvidenceArtifactVersionDto
}

export type EvidenceArtifactListDto = {
  items: EvidenceArtifactDto[]
}

export type EvidenceArtifactVersionListDto = {
  items: EvidenceArtifactVersionDto[]
}

export type EvidenceArtifactErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR'

export type EvidenceArtifactResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EvidenceArtifactErrorCode; message: string }

// The only fields a caller may supply when creating an artifact with its first version, or when
// appending a later one. Everything else — the id, the version number, the creating user, the
// organization and every timestamp the server owns — is derived, never accepted.
export const evidenceVersionInputFields = ['storageRef', 'contentHash', 'documentType', 'sourceDate', 'receivedAt'] as const

export const evidenceServerOwnedFields = [
  'id',
  'version',
  'evidenceArtifactId',
  'organizationId',
  'createdByUserId',
  'createdAt',
  'latestVersion',
  'versions',
] as const

export type EvidenceVersionInput = {
  storageRef: string
  contentHash: string
  documentType: string
  sourceDate: Date | null
  receivedAt: Date
}
