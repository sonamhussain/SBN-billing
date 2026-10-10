import { Router, type Request } from 'express'
import { getOrganization, updateOrganization } from './organization.service.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

const organizationRouter = Router()

function organizationIdFromParams(req: Request): string {
  return String(req.params.id)
}

function statusForServiceError(code: 'VALIDATION_ERROR' | 'NOT_FOUND') {
  return code === 'NOT_FOUND' ? 404 : 400
}

// Organization provisioning sits above the organization-scoped RBAC model, so it has no HTTP route.
// Local development provisions through src/scripts/provision-organization-dev.ts.

organizationRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromParams, 'organization.read'),
  async (req, res) => {
    const result = await getOrganization(organizationIdFromParams(req))

    if (!result.ok) {
      sendApiError(res, statusForServiceError(result.code), result.code, result.message)
      return
    }

    res.status(200).json(result.value)
  },
)

organizationRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromParams, 'organization.update'),
  async (req, res) => {
    const result = await updateOrganization(
      organizationIdFromParams(req),
      req.body?.name,
      String(res.locals.actorUserId),
    )

    if (!result.ok) {
      sendApiError(res, statusForServiceError(result.code), result.code, result.message)
      return
    }

    res.status(200).json(result.value)
  },
)

export default organizationRouter
