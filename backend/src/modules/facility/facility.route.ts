import { Router, type Response, type Request } from 'express'
import type { FacilityErrorCode } from './facility.types.ts'
import { createFacility, getFacility, updateFacility } from './facility.service.ts'
import { findFacilityById } from './facility.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'

export const organizationFacilityRouter = Router()
export const facilityRouter = Router()

function sendError(res: Response, code: FacilityErrorCode, message: string) {
  res.status(code === 'NOT_FOUND' ? 404 : 400).json({ error: { code, message } })
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function facilityIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingFacility(req: Request): Promise<string | null> {
  const facility = await findFacilityById(facilityIdFromParams(req))
  return facility?.organizationId ?? null
}

organizationFacilityRouter.post(
  '/:organizationId/facilities',
  requireOrganizationPermission(organizationIdFromRouteParam, 'facility.create'),
  async (req, res) => {
    const result = await createFacility(organizationIdFromRouteParam(req), req.body?.name)
    if (!result.ok) { sendError(res, result.code, result.message); return }
    res.status(201).json(result.value)
  },
)

facilityRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingFacility, 'facility.read'),
  async (req, res) => {
    const result = await getFacility(facilityIdFromParams(req))
    if (!result.ok) { sendError(res, result.code, result.message); return }
    res.status(200).json(result.value)
  },
)

facilityRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingFacility, 'facility.update'),
  async (req, res) => {
    const result = await updateFacility(facilityIdFromParams(req), req.body?.name)
    if (!result.ok) { sendError(res, result.code, result.message); return }
    res.status(200).json(result.value)
  },
)
