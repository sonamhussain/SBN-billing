import { useQuery } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/client.ts'
import { usePermission } from '../../shared/auth/usePermission.ts'

// FE-05 — reads one owner collection or record that sits under a parent (a contract's tariff schedules, a
// source's versions, a clinician's assignments). It loads only while `enabled` (the parent is open) and
// only with the exact read permission, so a missing permission shows "unavailable" instead of a request
// that must fail. The response is shown as the owner returned it.

export const ownerKey = (path: string) => ['admin-owner', path] as const

export function useOwnerItems<T>(path: string, permission: string | null, enabled = true) {
  const { can } = usePermission()
  const permitted = permission === null || can(permission)
  const query = useQuery({
    queryKey: ownerKey(path),
    queryFn: async () => (await apiRequest<{ items: T[] }>(path)).items,
    enabled: enabled && permitted,
  })
  return { ...query, permitted }
}

export function useOwnerRecord<T>(path: string | null, permission: string) {
  const permitted = usePermission().can(permission)
  const query = useQuery({
    queryKey: ownerKey(path ?? ''),
    queryFn: () => apiRequest<T>(path as string),
    enabled: permitted && path !== null,
    staleTime: 5 * 60_000,
  })
  return { ...query, permitted }
}
