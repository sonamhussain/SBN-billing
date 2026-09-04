import type { Request, Response, NextFunction } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../auth/auth.ts'
import { hasPermission } from './authorization.service.ts'
import type { PermissionCode } from './authorization.types.ts'
import { sendApiError } from '../errors/error-response.ts'

export function requireOrganizationPermission(
  getOrganizationId: (req: Request) => Promise<string | null> | string | null,
  permission: PermissionCode,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) {
      sendApiError(res, 401, 'UNAUTHENTICATED', 'sign in required')
      return
    }

    const organizationId = await getOrganizationId(req)
    if (!organizationId) {
      sendApiError(res, 404, 'NOT_FOUND', 'resource not found')
      return
    }

    if (!(await hasPermission(session.user.id, organizationId, permission))) {
      sendApiError(res, 403, 'FORBIDDEN', 'permission denied')
      return
    }

    res.locals.actorUserId = session.user.id
    next()
  }
}
