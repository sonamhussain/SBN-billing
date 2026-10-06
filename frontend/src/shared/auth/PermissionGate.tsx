import type { ReactNode } from 'react'
import { usePermission } from './usePermission.ts'

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
