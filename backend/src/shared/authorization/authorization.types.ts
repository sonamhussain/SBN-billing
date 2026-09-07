export const permissionCodes = [
  'organization.read',
  'organization.update',
  'facility.create',
  'facility.read',
  'facility.update',
  'audit.read',
  'clinician.create',
  'clinician.read',
  'clinician.update',
  'specialty.create',
  'specialty.read',
  'specialty.update',
] as const

export type PermissionCode = (typeof permissionCodes)[number]

export type AccessDecision =
  | { allowed: true; permissions: PermissionCode[] }
  | { allowed: false; reason: 'UNAUTHENTICATED' | 'NOT_MEMBER' | 'FORBIDDEN' }
