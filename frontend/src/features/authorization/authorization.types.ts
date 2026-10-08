// FE-04 — the A5.3 prior authorization and A5.4 authorization line contracts. A case is stable; every
// payer response, amendment or extension is a new immutable version. Lines are captured once per exact
// version. Scope evaluation is a read-only comparison whose outcomes are shown exactly as returned — a
// MATCHED line is not "authorization satisfied". Nothing is sent to a payer.

export const appendVersionKinds = ['RESPONSE', 'AMENDMENT', 'EXTENSION', 'CORRECTION'] as const
export type VersionKind = 'INITIAL' | (typeof appendVersionKinds)[number]

export const authorizationStatuses = ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'] as const
export type AuthorizationStatus = (typeof authorizationStatuses)[number]

// A payer decision: it needs a response time and RESPONSE evidence (enforced by the backend).
export const decisionStatuses = ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED'] as const

export const evidenceRoles = ['REQUEST', 'RESPONSE', 'SUPPORTING'] as const
export type EvidenceRole = (typeof evidenceRoles)[number]

export type AuthorizationEvidenceLink = { id: string; evidenceArtifactVersionId: string; role: EvidenceRole; createdAt: string }

export type PriorAuthorizationVersion = {
  id: string
  priorAuthorizationId: string
  version: number
  versionKind: VersionKind
  status: AuthorizationStatus
  authorizationReference: string | null
  eligibilityVerificationId: string | null
  requestedAt: string | null
  respondedAt: string | null
  validFrom: string | null
  validThrough: string | null
  evidenceLinks: AuthorizationEvidenceLink[]
  createdByUserId: string
  createdAt: string
}

export type PriorAuthorization = {
  id: string
  encounterId: string
  serviceDate: string
  latestRecordedVersion: PriorAuthorizationVersion
  createdAt: string
}

export type AuthorizationVersionInput = {
  versionKind: VersionKind
  status: AuthorizationStatus
  authorizationReference: string | null
  eligibilityVerificationId: string | null
  requestedAt: string | null
  respondedAt: string | null
  validFrom: string | null
  validThrough: string | null
  evidenceLinks: { role: EvidenceRole; evidenceArtifactVersionId: string }[]
}

export const lineStatuses = authorizationStatuses
export type LineStatus = AuthorizationStatus

export type AuthorizationLine = {
  id: string
  priorAuthorizationVersionId: string
  sequence: number
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  // Exact decimal strings; never converted to JavaScript numbers.
  requestedQty: string
  approvedQty: string | null
  unitCode: string | null
  approvedFrom: string | null
  approvedThrough: string | null
  status: LineStatus
  createdAt: string
}

export type AuthorizationLineInput = Omit<AuthorizationLine, 'id' | 'priorAuthorizationVersionId' | 'sequence' | 'createdAt'>

export type AuthorizationScopeEvaluation = {
  schemaVersion: 'AuthorizationScopeEvaluationV1'
  evaluatedAt: string
  priorAuthorizationVersionId: string
  contextMatch: boolean
  activities: { encounterActivityId: string; outcome: string; authorizationLineId: string | null; candidateAuthorizationLineIds: string[] }[]
  lineUtilization: { authorizationLineId: string; matchedActivityIds: string[]; matchedQty: string; approvedQty: string | null; quantityOutcome: string }[]
}
