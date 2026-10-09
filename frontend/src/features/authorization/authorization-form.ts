import { localInputToInstant } from '../../shared/format/date.ts'
import { decisionStatuses, type AuthorizationStatus, type AuthorizationVersionInput, type EvidenceRole, type VersionKind } from './authorization.types.ts'

// FE-04 — the authorization version form state, shared by "Record authorization" (always INITIAL, as the
// backend forces) and "Add authorization version". Every version carries at least one evidence link, so
// the form starts with one link row. The backend decides which combinations are valid (for example a
// decision status needs a response time and RESPONSE evidence).

export type EvidenceLinkDraft = { key: number; role: EvidenceRole | ''; evidenceArtifactVersionId: string }

export type AuthorizationDraft = {
  versionKind: VersionKind | ''
  status: AuthorizationStatus | ''
  authorizationReference: string
  eligibilityVerificationId: string
  requestedAt: string
  respondedAt: string
  validFrom: string
  validThrough: string
  evidenceLinks: EvidenceLinkDraft[]
}

export const emptyAuthorizationDraft = (versionKind: VersionKind | ''): AuthorizationDraft => ({
  versionKind,
  status: '',
  authorizationReference: '',
  eligibilityVerificationId: '',
  requestedAt: '',
  respondedAt: '',
  validFrom: '',
  validThrough: '',
  evidenceLinks: [{ key: 0, role: '', evidenceArtifactVersionId: '' }],
})

// The statuses the backend treats as a payer decision (APPROVED, PARTIALLY_APPROVED, DENIED).
export const isDecisionStatus = (status: AuthorizationDraft['status']) => (decisionStatuses as readonly string[]).includes(status)

export const draftIsComplete = (draft: AuthorizationDraft) =>
  draft.versionKind !== '' &&
  draft.status !== '' &&
  (!isDecisionStatus(draft.status) || draft.respondedAt !== '') &&
  draft.evidenceLinks.length > 0 &&
  draft.evidenceLinks.every((link) => link.role !== '' && link.evidenceArtifactVersionId !== '')

export function authorizationInput(draft: AuthorizationDraft): AuthorizationVersionInput {
  return {
    versionKind: draft.versionKind as VersionKind,
    status: draft.status as AuthorizationStatus,
    authorizationReference: draft.authorizationReference.trim() || null,
    eligibilityVerificationId: draft.eligibilityVerificationId || null,
    requestedAt: localInputToInstant(draft.requestedAt),
    respondedAt: localInputToInstant(draft.respondedAt),
    validFrom: draft.validFrom || null,
    validThrough: draft.validThrough || null,
    evidenceLinks: draft.evidenceLinks.map((link) => ({ role: link.role as EvidenceRole, evidenceArtifactVersionId: link.evidenceArtifactVersionId })),
  }
}
