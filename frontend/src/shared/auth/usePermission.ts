import { useContext } from 'react'
import { PermissionContext } from './permission-context.ts'

export function usePermission() {
  const context = useContext(PermissionContext)
  if (!context) throw new Error('usePermission must be used inside PermissionProvider')
  return context
}
