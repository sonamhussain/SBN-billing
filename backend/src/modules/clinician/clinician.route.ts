import { Router, type Request } from 'express'
import type { ClinicianErrorCode } from './clinician.types.ts'
import { createClinician, getClinician, listClinicians, updateClinician } from './clinician.service.ts'
import { findClinicianById } from './clinician.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationClinicianRouter = Router()
export const clinicianRouter = Router()

function statusForClinicianError(code: ClinicianErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function clinicianIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingClinician(req: Request): Promise<string | null> {
  const clinician = await findClinicianById(clinicianIdFromParams(req))
  return clinician?.organizationId ?? null
}

organizationClinicianRouter.post(
  '/:organizationId/clinicians',
  requireOrganizationPermission(organizationIdFromRouteParam, 'clinician.create'),
  async (req, res) => {
    const result = await createClinician(
      organizationIdFromRouteParam(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForClinicianError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationClinicianRouter.get(
  '/:organizationId/clinicians',
  requireOrganizationPermission(organizationIdFromRouteParam, 'clinician.read'),
  async (req, res) => {
    const result = await listClinicians(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForClinicianError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

clinicianRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingClinician, 'clinician.read'),
  async (req, res) => {
    const result = await getClinician(clinicianIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForClinicianError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

clinicianRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingClinician, 'clinician.update'),
  async (req, res) => {
    const result = await updateClinician(
      clinicianIdFromParams(req),
      req.body?.displayName,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForClinicianError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
