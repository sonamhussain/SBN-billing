import { useQuery } from '@tanstack/react-query'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { getCommercialContext, getProviderContract, getTariffSchedule, getTariffScheduleVersion } from './commercial-context.api.ts'

export const commercialKeys = {
  byEncounter: (encounterId: string) => ['pre-claim-commercial-context', encounterId] as const,
}

// A current resolution, read when the section opens and re-read only when the user asks. An unresolved
// or ambiguous answer is a final answer for that moment, so it is not retried.
export function useCommercialContext(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: commercialKeys.byEncounter(encounterId),
    queryFn: () => getCommercialContext(encounterId),
    enabled: enabled && encounterId !== '',
    retry: false,
  })
}

function useOwnerRead<T>(kind: string, id: string, permission: string, load: (id: string) => Promise<T>) {
  const permitted = usePermission().can(permission)
  const query = useQuery({
    queryKey: ['commercial-label', kind, id] as const,
    queryFn: () => load(id),
    enabled: permitted && id !== '',
    staleTime: 5 * 60_000,
  })
  return { ...query, permitted }
}

export const useProviderContract = (id: string) => useOwnerRead('provider-contract', id, 'provider_contract.read', getProviderContract)
export const useTariffSchedule = (id: string) => useOwnerRead('tariff-schedule', id, 'tariff_schedule.read', getTariffSchedule)
export const useTariffScheduleVersion = (id: string) =>
  useOwnerRead('tariff-schedule-version', id, 'tariff_schedule_version.read', getTariffScheduleVersion)
