import type { PermissionCode } from './authorization.types.ts'
import { findMembershipAccess } from './authorization.repository.ts'

export async function getEffectivePermissions(userId: string, organizationId: string) {
  const membership = await findMembershipAccess(userId, organizationId)
  if (!membership) return null

  const codes = new Set<string>()
  for (const mr of membership.roles) {
    for (const rp of mr.role.permissions) codes.add(rp.permission.code)
  }
  return { membershipId: membership.id, permissions: [...codes] }
}

export async function hasPermission(userId: string, organizationId: string, code: PermissionCode) {
  const access = await getEffectivePermissions(userId, organizationId)
  return !!access && access.permissions.includes(code)
}
