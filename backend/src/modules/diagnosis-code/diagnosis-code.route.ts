import { Router, type Request } from 'express'
import type { DiagnosisCodeErrorCode } from './diagnosis-code.types.ts'
import {
  createDiagnosisCode,
  getDiagnosisCode,
  listDiagnosisCodes,
  updateDiagnosisCode,
} from './diagnosis-code.service.ts'
import { findDiagnosisCodeById } from './diagnosis-code.repository.ts'
import { isDiagnosisCodeUuid } from './diagnosis-code.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationDiagnosisCodeRouter = Router()
export const diagnosisCodeRouter = Router()

function statusForDiagnosisCodeError(code: DiagnosisCodeErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function diagnosisCodeIdFromParams(req: Request): string {
  return String(req.params.diagnosisCodeId)
}

async function organizationIdFromExistingDiagnosisCode(req: Request): Promise<string | null> {
  const id = diagnosisCodeIdFromParams(req)
  if (!isDiagnosisCodeUuid(id)) return null
  const diagnosisCode = await findDiagnosisCodeById(id)
  return diagnosisCode?.organizationId ?? null
}

organizationDiagnosisCodeRouter.post(
  '/:organizationId/diagnosis-codes',
  requireOrganizationPermission(organizationIdFromRouteParam, 'diagnosisCode.create'),
  async (req, res) => {
    const result = await createDiagnosisCode(
      organizationIdFromRouteParam(req),
      req.body?.code,
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForDiagnosisCodeError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationDiagnosisCodeRouter.get(
  '/:organizationId/diagnosis-codes',
  requireOrganizationPermission(organizationIdFromRouteParam, 'diagnosisCode.read'),
  async (req, res) => {
    const result = await listDiagnosisCodes(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForDiagnosisCodeError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

diagnosisCodeRouter.get(
  '/:diagnosisCodeId',
  requireOrganizationPermission(organizationIdFromExistingDiagnosisCode, 'diagnosisCode.read'),
  async (req, res) => {
    const result = await getDiagnosisCode(diagnosisCodeIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForDiagnosisCodeError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

diagnosisCodeRouter.patch(
  '/:diagnosisCodeId',
  requireOrganizationPermission(organizationIdFromExistingDiagnosisCode, 'diagnosisCode.update'),
  async (req, res) => {
    const result = await updateDiagnosisCode(
      diagnosisCodeIdFromParams(req),
      req.body?.code,
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForDiagnosisCodeError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
