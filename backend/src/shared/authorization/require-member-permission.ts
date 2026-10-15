import type { Request, Response, NextFunction } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../auth/auth.ts'
import { getEffectivePermissions } from './authorization.service.ts'
import type { PermissionCode } from './authorization.types.ts'
import { sendApiError } from '../errors/error-response.ts'

// A6.3 §10 — the privacy-safe form of requireOrganizationPermission. A resource of an organization the
// caller is not a member of is answered exactly like a missing one (404), so its existence is never
// confirmed; only a member who lacks the permission receives 403. Every existing route keeps using
// requireOrganizationPermission unchanged.
export function requireMemberPermission(getOrganizationId: (req: Request) => Promise<string | null> | string | null, permission: PermissionCode) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) {
      sendApiError(res, 401, 'UNAUTHENTICATED', 'sign in required')
      return
    }

    const organizationId = await getOrganizationId(req)
    const access = organizationId ? await getEffectivePermissions(session.user.id, organizationId) : null
    if (!access) {
      sendApiError(res, 404, 'NOT_FOUND', 'resource not found')
      return
    }

    if (!access.permissions.includes(permission)) {
      sendApiError(res, 403, 'FORBIDDEN', 'permission denied')
      return
    }

    res.locals.actorUserId = session.user.id
    next()
  }
}
