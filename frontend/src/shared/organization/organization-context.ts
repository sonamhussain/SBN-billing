import { createContext } from 'react'

// FE-02 — one stable organization interface for every product consumer. Only the provider decides
// where the organization comes from; Patient/Insurance consumers never read configuration themselves.
export type OrganizationContextValue = {
  organizationId: string
  organizationName: string
  permissions: readonly string[]
}

export const OrganizationContext = createContext<OrganizationContextValue | null>(null)
