import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryClient } from '../shared/api/query-client.ts'
import { PermissionProvider } from '../shared/auth/PermissionProvider.tsx'

// The root grants no permission. Product routes receive the server's access-proof permissions from
// OrganizationBoundary (FE-02); anything outside it, such as the sign-in page, stays fail-closed.
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <PermissionProvider permissions={[]}>
        {children}
      </PermissionProvider>
    </QueryClientProvider>
  )
}
