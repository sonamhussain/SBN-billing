import { Router, type Request } from 'express'
import type { PayerErrorCode } from './payer.types.ts'
import { createPayer, getPayer, listPayers, updatePayer } from './payer.service.ts'
import { findPayerById } from './payer.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationPayerRouter = Router()
export const payerRouter = Router()

function statusForPayerError(code: PayerErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function payerIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingPayer(req: Request): Promise<string | null> {
  const payer = await findPayerById(payerIdFromParams(req))
  return payer?.organizationId ?? null
}

organizationPayerRouter.post(
  '/:organizationId/payers',
  requireOrganizationPermission(organizationIdFromRouteParam, 'payer.create'),
  async (req, res) => {
    const result = await createPayer(
      organizationIdFromRouteParam(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForPayerError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationPayerRouter.get(
  '/:organizationId/payers',
  requireOrganizationPermission(organizationIdFromRouteParam, 'payer.read'),
  async (req, res) => {
    const result = await listPayers(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForPayerError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

payerRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingPayer, 'payer.read'),
  async (req, res) => {
    const result = await getPayer(payerIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForPayerError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

payerRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingPayer, 'payer.update'),
  async (req, res) => {
    const result = await updatePayer(
      payerIdFromParams(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForPayerError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
