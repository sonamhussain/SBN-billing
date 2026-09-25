import { createContext, useContext, type ReactNode } from 'react'

// FE-01 — permission codes, never role names. Frontend gates improve UX only; the backend remains
// the security authority.

type PermissionContextValue = {
  permissions: ReadonlySet<string>
  can: (permission: string) => boolean
}

const PermissionContext = createContext<PermissionContextValue | null>(null)

export function PermissionProvider({
  permissions,
  children,
}: {
  permissions: readonly string[]
  children: ReactNode
}) {
  const set = new Set(permissions)
  return (
    <PermissionContext.Provider
      value={{ permissions: set, can: (permission) => set.has(permission) }}
    >
      {children}
    </PermissionContext.Provider>
  )
}

export function usePermission() {
  const context = useContext(PermissionContext)
  if (!context) throw new Error('usePermission must be used inside PermissionProvider')
  return context
}
