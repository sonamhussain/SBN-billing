import { readApiError } from '../../shared/api-error.ts'

// A5.5 — the minimal developer-check client.
//
// Only the Encounter UUID travels, in the path. There is no body and no query string, so no caller
// can name a date, payer, contract or tariff. Nothing is logged and nothing is written to
// localStorage, sessionStorage or IndexedDB.

export type PreClaimCommercialContext = {
  schemaVersion: 'PreClaimCommercialContextV1'
  resolvedAt: string
  organizationId: string
  encounterId: string
  serviceDate: string
  facilityId: string
  facilityRegulatoryProfileId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
}

// A resolution that did not produce exactly one contract and one tariff version. The reason is the
// machine-readable code; the message explains it.
export class ResolutionRefused extends Error {
  readonly reason: string | undefined
  constructor(message: string, reason: string | undefined) {
    super(message)
    this.reason = reason
  }
}

export async function resolveCommercialContext(encounterId: string): Promise<PreClaimCommercialContext> {
  const response = await fetch(`/api/encounters/${encounterId}/pre-claim-commercial-context`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new ResolutionRefused(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`, apiError.reason)
  }
  return response.json() as Promise<PreClaimCommercialContext>
}
