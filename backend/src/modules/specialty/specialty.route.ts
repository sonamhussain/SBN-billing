import { Router, type Request } from 'express'
import type { SpecialtyErrorCode } from './specialty.types.ts'
import { createSpecialty, getSpecialty, listSpecialties, updateSpecialty } from './specialty.service.ts'
import { findSpecialtyById } from './specialty.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationSpecialtyRouter = Router()
export const specialtyRouter = Router()

function statusForSpecialtyError(code: SpecialtyErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function specialtyIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingSpecialty(req: Request): Promise<string | null> {
  const specialty = await findSpecialtyById(specialtyIdFromParams(req))
  return specialty?.organizationId ?? null
}

organizationSpecialtyRouter.post(
  '/:organizationId/specialties',
  requireOrganizationPermission(organizationIdFromRouteParam, 'specialty.create'),
  async (req, res) => {
    const result = await createSpecialty(
      organizationIdFromRouteParam(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForSpecialtyError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationSpecialtyRouter.get(
  '/:organizationId/specialties',
  requireOrganizationPermission(organizationIdFromRouteParam, 'specialty.read'),
  async (req, res) => {
    const result = await listSpecialties(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForSpecialtyError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

specialtyRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingSpecialty, 'specialty.read'),
  async (req, res) => {
    const result = await getSpecialty(specialtyIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForSpecialtyError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

specialtyRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingSpecialty, 'specialty.update'),
  async (req, res) => {
    const result = await updateSpecialty(
      specialtyIdFromParams(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForSpecialtyError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
