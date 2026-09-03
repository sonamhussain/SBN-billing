import { Router } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../../shared/auth/auth.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import type { AccessProofResponse } from './access.types.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

const accessRouter = Router()

accessRouter.get('/organizations/:organizationId', async (req, res) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
  if (!session) {
    sendApiError(res, 401, 'UNAUTHENTICATED', 'sign in required')
    return
  }

  const organizationId = String(req.params.organizationId)
  const access = await getEffectivePermissions(session.user.id, organizationId)

  if (!access) {
    sendApiError(res, 403, 'FORBIDDEN', 'no access to this organization')
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
