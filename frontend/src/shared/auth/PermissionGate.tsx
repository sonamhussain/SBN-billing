import type { ReactNode } from 'react'
import { usePermission } from './PermissionContext.tsx'

export function PermissionGate({
  permission,
  children,
  fallback = null,
}: {
  permission: string
  children: ReactNode
  fallback?: ReactNode
}) {
  return usePermission().can(permission) ? children : fallback
}
