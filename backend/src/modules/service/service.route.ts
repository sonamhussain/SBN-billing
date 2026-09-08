import { Router, type Request } from 'express'
import type { ServiceErrorCode } from './service.types.ts'
import { createService, getService, listServices, updateService } from './service.service.ts'
import { findServiceById } from './service.repository.ts'
import { isServiceUuid } from './service.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationServiceRouter = Router()
export const serviceRouter = Router()

function statusForServiceError(code: ServiceErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function serviceIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingService(req: Request): Promise<string | null> {
  const id = serviceIdFromParams(req)
  if (!isServiceUuid(id)) return null
  const service = await findServiceById(id)
  return service?.organizationId ?? null
}

organizationServiceRouter.post(
  '/:organizationId/services',
  requireOrganizationPermission(organizationIdFromRouteParam, 'service.create'),
  async (req, res) => {
    const result = await createService(
      organizationIdFromRouteParam(req),
      req.body?.internalCode,
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForServiceError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationServiceRouter.get(
  '/:organizationId/services',
  requireOrganizationPermission(organizationIdFromRouteParam, 'service.read'),
  async (req, res) => {
    const result = await listServices(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForServiceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

serviceRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingService, 'service.read'),
  async (req, res) => {
    const result = await getService(serviceIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForServiceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

serviceRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingService, 'service.update'),
  async (req, res) => {
    const result = await updateService(
      serviceIdFromParams(req),
      req.body?.internalCode,
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForServiceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
