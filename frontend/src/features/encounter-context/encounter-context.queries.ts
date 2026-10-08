import { useQuery } from '@tanstack/react-query'
import { getEncounterBillingContext } from './encounter-context.api.ts'

export const contextKeys = {
  detail: (encounterId: string) => ['encounter-billing-context', encounterId] as const,
}

// Requested only when the user asks for it and holds encounterBillingContext.read; the aggregate carries
// patient identity and external references, so it is not fetched until it is needed. A 409 integrity
// conflict is a final answer, not a transient failure, so it is never retried.
export function useEncounterBillingContext(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: contextKeys.detail(encounterId),
    queryFn: () => getEncounterBillingContext(encounterId),
    enabled: enabled && encounterId !== '',
    retry: false,
  })
}
