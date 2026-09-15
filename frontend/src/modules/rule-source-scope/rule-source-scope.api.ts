import { readApiError } from '../../shared/api-error.ts'

export type RuleSourceScope = {
  id: string
  sourceId: string
  facilityId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  createdAt: string
}

export type ScopeDimensions = {
  facilityId: string
  payerId: string
  tpaId: string
  networkId: string
  insuranceProductId: string
  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

function dimensionsBody(dimensions: ScopeDimensions) {
  return {
    facilityId: dimensions.facilityId || null,
    payerId: dimensions.payerId || null,
    tpaId: dimensions.tpaId || null,
    networkId: dimensions.networkId || null,
    insuranceProductId: dimensions.insuranceProductId || null,
    providerContractId: dimensions.providerContractId || null,
    tariffScheduleId: dimensions.tariffScheduleId || null,
    tariffScheduleVersionId: dimensions.tariffScheduleVersionId || null,
  }
}

export async function createRuleSourceScope(sourceId: string, dimensions: ScopeDimensions): Promise<RuleSourceScope> {
  return handle(
    await fetch(`/api/rule-sources/${sourceId}/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dimensionsBody(dimensions)),
    }),
  )
}

export async function loadRuleSourceScopes(sourceId: string): Promise<RuleSourceScope[]> {
  const data = await handle<{ items: RuleSourceScope[] }>(await fetch(`/api/rule-sources/${sourceId}/scopes`))
  return data.items
}
