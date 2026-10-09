import { formatDateOnly, formatInstant, localInputToInstant } from '../../shared/format/date.ts'
import type { EvidenceArtifactVersion, EvidenceVersionInput } from './evidence.types.ts'

// FE-04 — the evidence metadata form state and how a version is named. A version label shows the document
// type, receipt time and version number; the opaque storage reference and hash appear only in an
// explicitly opened detail.

export type EvidenceDraft = { storageRef: string; contentHash: string; documentType: string; sourceDate: string; receivedAt: string }

export const emptyEvidenceDraft: EvidenceDraft = { storageRef: '', contentHash: '', documentType: '', sourceDate: '', receivedAt: '' }

// Values are sent as entered (the backend validates them); only the local receipt time becomes an instant.
export function evidenceInput(draft: EvidenceDraft): EvidenceVersionInput {
  return {
    storageRef: draft.storageRef,
    contentHash: draft.contentHash.trim(),
    documentType: draft.documentType,
    sourceDate: draft.sourceDate || null,
    receivedAt: localInputToInstant(draft.receivedAt) ?? '',
  }
}

export function describeEvidenceVersion(version: EvidenceArtifactVersion) {
  const source = version.sourceDate ? ` · source ${formatDateOnly(version.sourceDate)}` : ''
  return `${version.documentType} · received ${formatInstant(version.receivedAt)}${source} · v${version.version}`
}

// A registered evidence item in a chooser, named by its latest version.
export function describeEvidenceArtifact(latest: EvidenceArtifactVersion) {
  return `${latest.documentType} · received ${formatInstant(latest.receivedAt)} · latest v${latest.version}`
}
