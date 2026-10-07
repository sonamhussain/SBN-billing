import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AppStatus } from '../layout/AppStatus.tsx'
import { OrganizationContext } from './organization-context.ts'
import { getOrganization, getOrganizationAccess } from './organization.api.ts'

// FE-02 — fail closed. The configured organization is used only after the server confirms this user's
// membership in it; until then nothing organization-scoped renders, and the permission codes come from
// that same server answer. The ID is never persisted in browser storage.
const configuredOrganizationId = import.meta.env.VITE_ACTIVE_ORGANIZATION_ID?.trim() ?? ''

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const organizationId = configuredOrganizationId

  const access = useQuery({
    queryKey: ['organization-access', organizationId],
    queryFn: () => getOrganizationAccess(organizationId),
    enabled: organizationId !== '',
    retry: false,
  })

  const organization = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => getOrganization(organizationId),
    enabled: access.isSuccess,
    retry: false,
  })

  if (organizationId === '') return <AppStatus label="Organization context is not configured." />
  if (access.isPending || (access.isSuccess && organization.isPending)) return <AppStatus label="Loading organization..." />
  if (access.isError || organization.isError || !access.data || !organization.data) {
    return <AppStatus label="Organization access is unavailable." />
  }

  return (
    <OrganizationContext.Provider
      value={{ organizationId, organizationName: organization.data.name, permissions: access.data.permissions }}
    >
      {children}
    </OrganizationContext.Provider>
  )
}
