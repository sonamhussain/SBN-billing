import { apiRequest } from '../../shared/api/client.ts'
import type { PreClaimCommercialContext, ProviderContractLabel, TariffScheduleLabel, TariffScheduleVersionLabel } from './commercial-context.types.ts'

// FE-04 — the read-only A5.5 resolution and the owner reads that name what it resolved. Nothing here
// selects a contract or tariff, and no business date is sent: the Encounter's service date is authoritative.

export function getCommercialContext(encounterId: string) {
  return apiRequest<PreClaimCommercialContext>(`/api/encounters/${encounterId}/pre-claim-commercial-context`)
}

export const getProviderContract = (id: string) => apiRequest<ProviderContractLabel>(`/api/provider-contracts/${id}`)
export const getTariffSchedule = (id: string) => apiRequest<TariffScheduleLabel>(`/api/tariff-schedules/${id}`)
export const getTariffScheduleVersion = (id: string) => apiRequest<TariffScheduleVersionLabel>(`/api/tariff-schedule-versions/${id}`)
