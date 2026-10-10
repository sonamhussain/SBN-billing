import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/client.ts'
import { usePermission } from '../../shared/auth/usePermission.ts'

// FE-05 — the owner routes of one organization-scoped master (Clinician, Payer, Service, ...): list and
// create under /api/organizations/:id/<collection>, read and PATCH under /api/<collection>/:id. Each owner
// declares its own collection, permissions and fields; nothing here knows a master's meaning.

export type MasterOwner = {
  // URL collection segment, identical under the organization and at the top level, e.g. 'procedure-codes'.
  collection: string
  read: string
  create: string
  update: string
}

const masterKey = (owner: MasterOwner, organizationId: string) => ['admin-master', owner.collection, organizationId] as const

export function useMasterList<T>(owner: MasterOwner, organizationId: string) {
  const permitted = usePermission().can(owner.read)
  const query = useQuery({
    queryKey: masterKey(owner, organizationId),
    queryFn: async () => (await apiRequest<{ items: T[] }>(`/api/organizations/${organizationId}/${owner.collection}`)).items,
    enabled: permitted && organizationId !== '',
  })
  return { ...query, permitted }
}

// No optimistic writes: the server confirms, then the owner list and the label caches other workspaces
// keep for the same masters are refreshed so a renamed record is not shown under its old name.
export function useMasterMutations<T>(owner: MasterOwner, organizationId: string) {
  const client = useQueryClient()
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: masterKey(owner, organizationId) }),
      client.invalidateQueries({ queryKey: ['encounter-lookup'] }),
      client.invalidateQueries({ queryKey: ['encounter-label'] }),
      client.invalidateQueries({ queryKey: ['coverage-master'] }),
    ])

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<T>(`/api/organizations/${organizationId}/${owner.collection}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: refresh,
  })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiRequest<T>(`/api/${owner.collection}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: refresh,
  })
  return { create, update }
}
