// A5.3 — a PriorAuthorization is one authorization CASE: which authorization this is, for one exact
// Encounter context. Its context is frozen at creation, so if the Encounter later moves to a
// different membership, facility or clinician, that is a new case rather than a rewrite of this one.
//
// A PriorAuthorizationVersion is one immutable lifecycle snapshot. A later payer response, an
// amendment, an extension or a correction is a NEW version; no earlier version is ever patched, and
// every version is complete — it inherits nothing from the version before it.
//
// A5.3 records the authorization header and nothing about lines. It may record a payer-reported
// PARTIALLY_APPROVED, but it never says WHICH activity is approved, in what quantity or for which
// dates: A5.4 alone owns AuthorizationLines. A5.3 also decides no readiness, selects no contract or
// tariff, and performs no external authorization request.

// Why this immutable snapshot exists. Version 1 is always INITIAL; a later version never is.
export const versionKinds = ['INITIAL', 'RESPONSE', 'AMENDMENT', 'EXTENSION', 'CORRECTION'] as const
export type VersionKind = (typeof versionKinds)[number]

// What the authorization source reported at this version. UNKNOWN is a first-class answer and is
// never resolved into approval. EXPIRED and ACTIVE are deliberately absent: validity is validFrom
// and validThrough, and whether an authorization still applies is decided by A5.4 and A5.8.
export const authorizationStatuses = ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'] as const
export type AuthorizationStatus = (typeof authorizationStatuses)[number]

// A status the payer actually decided, as opposed to one that merely reports where the request got
// to. These require both a response instant and RESPONSE evidence.
export const decisionStatuses = ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED'] as const

// Version kinds that exist because something came back, so they too require RESPONSE evidence.
export const responseBearingKinds = ['RESPONSE', 'AMENDMENT', 'EXTENSION'] as const

// The role this evidence plays for this version. It is not a document type, and no payer document
// vocabulary is assumed or enforced.
export const evidenceRoles = ['REQUEST', 'RESPONSE', 'SUPPORTING'] as const
export type EvidenceRole = (typeof evidenceRoles)[number]

export type EvidenceLinkInput = {
  role: EvidenceRole
  evidenceArtifactVersionId: string
}

export type EvidenceLinkDto = {
  id: string
  evidenceArtifactVersionId: string
  role: EvidenceRole
  createdAt: string
}

export type PriorAuthorizationVersionDto = {
  id: string
  priorAuthorizationId: string
  // Server-owned, gap-free per authorization, starting at 1.
  version: number
  versionKind: VersionKind
  status: AuthorizationStatus
  // An opaque payer or portal reference. Case is preserved and nothing is unique about it.
  authorizationReference: string | null
  // Optional provenance only. Linking an eligibility verification never makes eligibility an input
  // to the authorization result.
  eligibilityVerificationId: string | null
  requestedAt: string | null
  respondedAt: string | null
  validFrom: string | null
  validThrough: string | null
  // Exact A5.1 links. No storage reference, hash or document type is copied.
  evidenceLinks: EvidenceLinkDto[]
  createdByUserId: string
  createdAt: string
}

export type PriorAuthorizationDto = {
  id: string
  encounterId: string
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  facilityId: string
  clinicianId: string
  serviceDate: string
  // The most recently recorded version, offered as a convenience. It is LATEST RECORDED and nothing
  // more: it is not the current, usable or satisfied version. Deciding which version applies to a
  // claim context belongs to A5.4 and A5.8.
  latestRecordedVersion: PriorAuthorizationVersionDto
  createdAt: string
}

export type PriorAuthorizationListDto = { items: PriorAuthorizationDto[] }
export type PriorAuthorizationVersionListDto = { items: PriorAuthorizationVersionDto[] }

export type PriorAuthorizationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR'

export type PriorAuthorizationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PriorAuthorizationErrorCode; message: string }

// The only fields a caller may supply, for both creating a case and appending a version. The
// Encounter comes from the route; the membership, commercial identities, facility, clinician and
// service date are derived by the server inside the write transaction.
export const versionInputFields = [
  'versionKind',
  'status',
  'authorizationReference',
  'eligibilityVerificationId',
  'requestedAt',
  'respondedAt',
  'validFrom',
  'validThrough',
  'evidenceLinks',
] as const

// Supplying any of these would let a caller choose the context an authorization is frozen against,
// or claim a position in the version sequence. Each is refused by name rather than ignored.
export const versionServerOwnedFields = [
  'id',
  'priorAuthorizationId',
  'version',
  'encounterId',
  'insuranceMembershipId',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'facilityId',
  'clinicianId',
  'serviceDate',
  'createdByUserId',
  'createdAt',
  'latestRecordedVersion',
  'isCurrent',
  'isActive',
  'isSatisfied',
] as const

export const evidenceLinkFields = ['role', 'evidenceArtifactVersionId'] as const

// What the server resolved inside the write transaction, after taking the Encounter and membership
// locks. It is the exact context the authorization case is frozen against.
export type AuthorizationContext = {
  encounterId: string
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  facilityId: string
  clinicianId: string
  serviceDate: Date
}

export type VersionInput = {
  versionKind: VersionKind
  status: AuthorizationStatus
  authorizationReference: string | null
  eligibilityVerificationId: string | null
  requestedAt: Date | null
  respondedAt: Date | null
  validFrom: Date | null
  validThrough: Date | null
  evidenceLinks: EvidenceLinkInput[]
}
