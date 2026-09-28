import { readApiError } from '../../shared/api-error.ts'

// A5.2 — the minimal developer-check client.
//
// Verification facts travel only in request and response bodies. Nothing is placed in a URL query,
// nothing is logged, and nothing is written to localStorage, sessionStorage or IndexedDB. Only SBN
// UUIDs appear in a path.
//
// There is deliberately no update or delete call, and no verify call: A5.2 records what a
// verification reported, it never performs one.

export type FreshnessState = 'FRESH' | 'STALE' | 'UNKNOWN'

export type EligibilityVerification = {
  id: string
  encounterId: string
  insuranceMembershipId: string
  serviceDate: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  verificationMethod: 'ELECTRONIC' | 'PORTAL' | 'MANUAL' | 'OTHER'
  status: 'ELIGIBLE' | 'INELIGIBLE' | 'UNKNOWN'
  requestedAt: string | null
  respondedAt: string
  validThrough: string | null
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
  // Derived at read time, never stored. FRESH describes the validity boundary, not the result.
  freshness: { state: FreshnessState; evaluatedAt: string }
  createdAt: string
}

export type VerificationInput = {
  verificationMethod: EligibilityVerification['verificationMethod']
  status: EligibilityVerification['status']
  requestedAt: string | null
  respondedAt: string
  validThrough: string | null
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createEligibilityVerification(encounterId: string, input: VerificationInput): Promise<EligibilityVerification> {
  return handle(
    await fetch(`/api/encounters/${encounterId}/eligibility-verifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function listEligibilityVerifications(encounterId: string): Promise<EligibilityVerification[]> {
  const body = await handle<{ items: EligibilityVerification[] }>(await fetch(`/api/encounters/${encounterId}/eligibility-verifications`))
  return body.items
}
