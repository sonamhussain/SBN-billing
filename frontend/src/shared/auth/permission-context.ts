import { createContext } from 'react'

// FE-01 — permission codes, never role names. Frontend gates improve UX only; the backend remains
// the security authority.

export type PermissionContextValue = {
  permissions: ReadonlySet<string>
  can: (permission: string) => boolean
}

export const PermissionContext = createContext<PermissionContextValue | null>(null)
