import { Router, type Request } from 'express'
import type { ProcedureCodeErrorCode } from './procedure-code.types.ts'
import {
  createProcedureCode,
  getProcedureCode,
  listProcedureCodes,
  updateProcedureCode,
} from './procedure-code.service.ts'
import { findProcedureCodeById } from './procedure-code.repository.ts'
import { isProcedureCodeUuid } from './procedure-code.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationProcedureCodeRouter = Router()
export const procedureCodeRouter = Router()

function statusForProcedureCodeError(code: ProcedureCodeErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function procedureCodeIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingProcedureCode(req: Request): Promise<string | null> {
  const id = procedureCodeIdFromParams(req)
  if (!isProcedureCodeUuid(id)) return null
  const procedureCode = await findProcedureCodeById(id)
  return procedureCode?.organizationId ?? null
}

organizationProcedureCodeRouter.post(
  '/:organizationId/procedure-codes',
  requireOrganizationPermission(organizationIdFromRouteParam, 'procedure_code.create'),
  async (req, res) => {
    const result = await createProcedureCode(
      organizationIdFromRouteParam(req),
      req.body?.internalCode,
      req.body?.displayName,
      req.body?.codeSystem,
      req.body?.externalCode,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForProcedureCodeError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationProcedureCodeRouter.get(
  '/:organizationId/procedure-codes',
  requireOrganizationPermission(organizationIdFromRouteParam, 'procedure_code.read'),
  async (req, res) => {
    const result = await listProcedureCodes(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForProcedureCodeError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

procedureCodeRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProcedureCode, 'procedure_code.read'),
  async (req, res) => {
    const result = await getProcedureCode(procedureCodeIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForProcedureCodeError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

procedureCodeRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProcedureCode, 'procedure_code.update'),
  async (req, res) => {
    const result = await updateProcedureCode(
      procedureCodeIdFromParams(req),
      req.body?.internalCode,
      req.body?.displayName,
      req.body?.codeSystem,
      req.body?.externalCode,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForProcedureCodeError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
