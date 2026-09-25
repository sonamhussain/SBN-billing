import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryClient } from '../shared/api/query-client.ts'
import { PermissionProvider } from '../shared/auth/PermissionContext.tsx'

// FE-01 defines the permission infrastructure but does not invent the current Organization or a
// permission-loading API; a later FE module supplies authoritative permissions here.
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <PermissionProvider permissions={[]}>
        {children}
      </PermissionProvider>
    </QueryClientProvider>
  )
}
