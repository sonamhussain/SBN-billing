import { useQuery } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/client.ts'

// FE-02 — read-only Payer, TPA, Network and InsuranceProduct options of the current organization, from
// the existing master read APIs. They feed both the coverage selectors and the display names, so a
// master is fetched once per organization and never copied into persistent storage. A name that cannot
// be resolved is shown as 'Unavailable', never as a raw identifier.

export type NamedMaster = { id: string; displayName: string }
export type InsuranceProductOption = NamedMaster & { payerId: string }

async function listItems<T>(path: string) {
  return (await apiRequest<{ items: T[] }>(path)).items
}

const masterQuery = <T,>(organizationId: string, kind: string) => ({
  queryKey: ['coverage-master', organizationId, kind] as const,
  queryFn: () => listItems<T>(`/api/organizations/${organizationId}/${kind}`),
  staleTime: 5 * 60_000,
})

export function useCoverageMasters(organizationId: string) {
  const payers = useQuery(masterQuery<NamedMaster>(organizationId, 'payers'))
  const tpas = useQuery(masterQuery<NamedMaster>(organizationId, 'tpas'))
  const networks = useQuery(masterQuery<NamedMaster>(organizationId, 'networks'))
  const products = useQuery(masterQuery<InsuranceProductOption>(organizationId, 'insurance-products'))
  return { payers, tpas, networks, products }
}

export function labelOf(items: readonly NamedMaster[] | undefined, id: string | null) {
  if (id === null) return null
  return items?.find((item) => item.id === id)?.displayName ?? 'Unavailable'
}
