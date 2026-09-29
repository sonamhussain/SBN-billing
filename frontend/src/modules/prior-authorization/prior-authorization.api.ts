import { readApiError } from '../../shared/api-error.ts'

// A5.3 — the minimal developer-check client.
//
// Authorization facts travel only in request and response bodies. Nothing is placed in a URL query,
// nothing is logged, and nothing is written to localStorage, sessionStorage or IndexedDB. Only SBN
// UUIDs appear in a path.
//
// There is deliberately no update or delete call, and no request or submit call: A5.3 records what
// an authorization source reported, it never performs an authorization.

export type VersionKind = 'INITIAL' | 'RESPONSE' | 'AMENDMENT' | 'EXTENSION' | 'CORRECTION'
export type AuthorizationStatus = 'REQUESTED' | 'PENDING' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'DENIED' | 'UNKNOWN'
export type EvidenceRole = 'REQUEST' | 'RESPONSE' | 'SUPPORTING'

export type EvidenceLink = {
  id: string
  evidenceArtifactVersionId: string
  role: EvidenceRole
  createdAt: string
}

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
  evidenceLinks: EvidenceLink[]
  createdByUserId: string
  createdAt: string
}

export type PriorAuthorization = {
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
  // The most recently recorded version. It is LATEST RECORDED and nothing more — not the current,
  // usable or satisfied version. That decision belongs to A5.4 and A5.8.
  latestRecordedVersion: PriorAuthorizationVersion
  createdAt: string
}

export type VersionInput = {
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

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function createPriorAuthorization(encounterId: string, input: VersionInput): Promise<PriorAuthorization> {
  return handle(await post(`/api/encounters/${encounterId}/prior-authorizations`, input))
}

export async function listPriorAuthorizations(encounterId: string): Promise<PriorAuthorization[]> {
  const body = await handle<{ items: PriorAuthorization[] }>(await fetch(`/api/encounters/${encounterId}/prior-authorizations`))
  return body.items
}

export async function listVersions(authorizationId: string): Promise<PriorAuthorizationVersion[]> {
  const body = await handle<{ items: PriorAuthorizationVersion[] }>(await fetch(`/api/prior-authorizations/${authorizationId}/versions`))
  return body.items
}

// A correction is a new version, never an edit: there is deliberately no update or delete call.
export async function appendVersion(authorizationId: string, input: VersionInput): Promise<PriorAuthorizationVersion> {
  return handle(await post(`/api/prior-authorizations/${authorizationId}/versions`, input))
}
