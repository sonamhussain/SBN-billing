import { readApiError } from '../../shared/api-error.ts'

export type InsuranceProduct = { id: string; organizationId: string; payerId: string; productCode: string; displayName: string }
export type ProviderContract = { id: string; organizationId: string; insuranceProductId: string | null; contractKey: string; displayName: string }
export type ContractFacility = { id: string; providerContractId: string; facilityId: string }
export type TariffSchedule = { id: string; providerContractId: string; tariffKey: string; displayName: string }
export type TariffScheduleVersion = { id: string; tariffScheduleId: string; version: string; verificationStatus: string }

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createInsuranceProduct(organizationId: string, payerId: string, productCode: string, displayName: string): Promise<InsuranceProduct> {
  return handle(
    await fetch(`/api/organizations/${organizationId}/insurance-products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payerId, productCode, displayName }),
    }),
  )
}

export async function createProviderContract(
  organizationId: string,
  contractKey: string,
  displayName: string,
  insuranceProductId: string,
): Promise<ProviderContract> {
  return handle(
    await fetch(`/api/organizations/${organizationId}/provider-contracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractKey, displayName, insuranceProductId: insuranceProductId || null }),
    }),
  )
}

export async function createContractFacility(providerContractId: string, facilityId: string): Promise<ContractFacility> {
  return handle(
    await fetch(`/api/provider-contracts/${providerContractId}/contract-facilities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facilityId }),
    }),
  )
}

export async function createTariffSchedule(providerContractId: string, tariffKey: string, displayName: string): Promise<TariffSchedule> {
  return handle(
    await fetch(`/api/provider-contracts/${providerContractId}/tariff-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tariffKey, displayName }),
    }),
  )
}

export async function createTariffScheduleVersion(tariffScheduleId: string, version: string): Promise<TariffScheduleVersion> {
  return handle(
    await fetch(`/api/tariff-schedules/${tariffScheduleId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    }),
  )
}
