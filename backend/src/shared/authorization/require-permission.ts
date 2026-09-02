import type { Request, Response, NextFunction } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../auth/auth.ts'
import { hasPermission } from './authorization.service.ts'
import type { PermissionCode } from './authorization.types.ts'

export function requireOrganizationPermission(
  getOrganizationId: (req: Request) => Promise<string | null> | string | null,
  permission: PermissionCode,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'sign in required' } })
      return
    }

    const organizationId = await getOrganizationId(req)
    if (!organizationId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'resource not found' } })
      return
    }

    if (!(await hasPermission(session.user.id, organizationId, permission))) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'permission denied' } })
      return
    }

    next()
  }
}
