import type { ReactNode } from 'react'
import { PermissionContext } from './permission-context.ts'

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
