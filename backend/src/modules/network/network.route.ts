import { Router, type Request } from 'express'
import type { NetworkErrorCode } from './network.types.ts'
import { createNetwork, getNetwork, listNetworks, updateNetwork } from './network.service.ts'
import { findNetworkById } from './network.repository.ts'
import { isNetworkUuid } from './network.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationNetworkRouter = Router()
export const networkRouter = Router()

function statusForNetworkError(code: NetworkErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function networkIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingNetwork(req: Request): Promise<string | null> {
  const id = networkIdFromParams(req)
  if (!isNetworkUuid(id)) return null
  const network = await findNetworkById(id)
  return network?.organizationId ?? null
}

organizationNetworkRouter.post(
  '/:organizationId/networks',
  requireOrganizationPermission(organizationIdFromRouteParam, 'network.create'),
  async (req, res) => {
    const result = await createNetwork(
      organizationIdFromRouteParam(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForNetworkError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationNetworkRouter.get(
  '/:organizationId/networks',
  requireOrganizationPermission(organizationIdFromRouteParam, 'network.read'),
  async (req, res) => {
    const result = await listNetworks(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForNetworkError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

networkRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingNetwork, 'network.read'),
  async (req, res) => {
    const result = await getNetwork(networkIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForNetworkError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

networkRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingNetwork, 'network.update'),
  async (req, res) => {
    const result = await updateNetwork(
      networkIdFromParams(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForNetworkError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
