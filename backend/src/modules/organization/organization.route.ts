import { Router, type Response, type Request } from 'express'
import type { ServiceErrorCode } from './organization.types.ts'
import {
  createOrganization,
  getOrganization,
  updateOrganization,
} from './organization.service.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'

const organizationRouter = Router()

function organizationIdFromParams(req: Request): string {
  return String(req.params.id)
}

function sendError(
  res: Response,
  code: ServiceErrorCode,
  message: string,
) {
  const status = code === 'NOT_FOUND' ? 404 : 400
  res.status(status).json({ error: { code, message } })
}

organizationRouter.post('/', async (req, res) => {
  const result = await createOrganization(req.body?.name)

  if (!result.ok) {
    sendError(res, result.code, result.message)
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
      sendError(res, result.code, result.message)
      return
    }

    res.status(200).json(result.value)
  },
)

organizationRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromParams, 'organization.update'),
  async (req, res) => {
    const result = await updateOrganization(organizationIdFromParams(req), req.body?.name)

    if (!result.ok) {
      sendError(res, result.code, result.message)
      return
    }

    res.status(200).json(result.value)
  },
)

export default organizationRouter
