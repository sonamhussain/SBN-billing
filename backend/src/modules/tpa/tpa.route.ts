import { Router, type Request } from 'express'
import type { TpaErrorCode } from './tpa.types.ts'
import { createTpa, getTpa, listTpas, updateTpa } from './tpa.service.ts'
import { findTpaById } from './tpa.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationTpaRouter = Router()
export const tpaRouter = Router()

function statusForTpaError(code: TpaErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function tpaIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingTpa(req: Request): Promise<string | null> {
  const tpa = await findTpaById(tpaIdFromParams(req))
  return tpa?.organizationId ?? null
}

organizationTpaRouter.post(
  '/:organizationId/tpas',
  requireOrganizationPermission(organizationIdFromRouteParam, 'tpa.create'),
  async (req, res) => {
    const result = await createTpa(
      organizationIdFromRouteParam(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForTpaError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationTpaRouter.get(
  '/:organizationId/tpas',
  requireOrganizationPermission(organizationIdFromRouteParam, 'tpa.read'),
  async (req, res) => {
    const result = await listTpas(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForTpaError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

tpaRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingTpa, 'tpa.read'),
  async (req, res) => {
    const result = await getTpa(tpaIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForTpaError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

tpaRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingTpa, 'tpa.update'),
  async (req, res) => {
    const result = await updateTpa(
      tpaIdFromParams(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForTpaError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
