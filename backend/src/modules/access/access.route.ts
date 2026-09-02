import { Router } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../../shared/auth/auth.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import type { AccessProofResponse } from './access.types.ts'

const accessRouter = Router()

accessRouter.get('/organizations/:organizationId', async (req, res) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
  if (!session) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'sign in required' } })
    return
  }

  const organizationId = String(req.params.organizationId)
  const access = await getEffectivePermissions(session.user.id, organizationId)

  if (!access) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'no access to this organization' } })
    return
  }

  const body: AccessProofResponse = {
    organizationId,
    membershipId: access.membershipId,
    permissions: access.permissions,
  }
  res.status(200).json(body)
})

export default accessRouter
