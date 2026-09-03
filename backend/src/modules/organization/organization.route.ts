import { Router, type Request } from 'express'
import {
  createOrganization,
  getOrganization,
  updateOrganization,
} from './organization.service.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

const organizationRouter = Router()

function organizationIdFromParams(req: Request): string {
  return String(req.params.id)
}

function statusForServiceError(code: 'VALIDATION_ERROR' | 'NOT_FOUND') {
  return code === 'NOT_FOUND' ? 404 : 400
}

organizationRouter.post('/', async (req, res) => {
  const result = await createOrganization(req.body?.name)

  if (!result.ok) {
    sendApiError(res, statusForServiceError(result.code), result.code, result.message)
    return
  }

  res.status(201).json(result.value)
})

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
