import { Outlet } from 'react-router-dom'
import { PermissionProvider } from '../shared/auth/PermissionProvider.tsx'
import { OrganizationProvider } from '../shared/organization/OrganizationProvider.tsx'
import { useOrganization } from '../shared/organization/useOrganization.ts'

// FE-02 — sits inside AuthBoundary, so the sign-in page is never wrapped and no organization request is
// made before a session exists. Permission codes come only from the server's access proof.
function AuthorizedPermissions() {
  const { permissions } = useOrganization()
  return (
    <PermissionProvider permissions={permissions}>
      <Outlet />
    </PermissionProvider>
  )
}

export function OrganizationBoundary() {
  return (
    <OrganizationProvider>
      <AuthorizedPermissions />
    </OrganizationProvider>
  )
}
