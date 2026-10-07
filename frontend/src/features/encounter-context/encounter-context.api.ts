import { apiRequest } from '../../shared/api/client.ts'
import type { EncounterBillingContext } from './encounter-context.types.ts'

// FE-03 — the one A4.9 aggregate read. There is no write path.
export function getEncounterBillingContext(encounterId: string) {
  return apiRequest<EncounterBillingContext>(`/api/encounters/${encounterId}/billing-context`)
}
