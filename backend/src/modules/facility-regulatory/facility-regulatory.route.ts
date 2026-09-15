import { Router, type Request } from 'express'
import type { FacilityRegulatoryProfileErrorCode } from './facility-regulatory.types.ts'
import {
  activateFacilityRegulatoryProfile,
  createFacilityRegulatoryProfile,
  getFacilityRegulatoryProfile,
  listFacilityRegulatoryProfiles,
  updateFacilityRegulatoryProfile,
} from './facility-regulatory.service.ts'
import { findFacilityRegulatoryProfileWithFacility } from './facility-regulatory.repository.ts'
import { findFacilityById } from '../facility/facility.repository.ts'
import { isFacilityRegulatoryProfileUuid } from './facility-regulatory.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const facilityRegulatoryProfilesRouter = Router()
export const facilityRegulatoryProfileRouter = Router()

function statusForError(code: FacilityRegulatoryProfileErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function facilityIdFromParams(req: Request): string {
  return String(req.params.facilityId)
}

function profileIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromParentFacility(req: Request): Promise<string | null> {
  const facilityId = facilityIdFromParams(req)
  if (!isFacilityRegulatoryProfileUuid(facilityId)) return null
  const facility = await findFacilityById(facilityId)
  return facility?.organizationId ?? null
}

async function organizationIdFromExistingProfile(req: Request): Promise<string | null> {
  const id = profileIdFromParams(req)
  if (!isFacilityRegulatoryProfileUuid(id)) return null
  const profile = await findFacilityRegulatoryProfileWithFacility(id)
  return profile?.facility.organizationId ?? null
}

facilityRegulatoryProfilesRouter.post(
  '/:facilityId/regulatory-profiles',
  requireOrganizationPermission(organizationIdFromParentFacility, 'facility_regulatory_profile.create'),
  async (req, res) => {
    const result = await createFacilityRegulatoryProfile(
      facilityIdFromParams(req),
      req.body?.jurisdictionCode,
      req.body?.regulatoryAuthorityCode,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

facilityRegulatoryProfilesRouter.get(
  '/:facilityId/regulatory-profiles',
  requireOrganizationPermission(organizationIdFromParentFacility, 'facility_regulatory_profile.read'),
  async (req, res) => {
    const result = await listFacilityRegulatoryProfiles(facilityIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

facilityRegulatoryProfileRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProfile, 'facility_regulatory_profile.read'),
  async (req, res) => {
    const result = await getFacilityRegulatoryProfile(profileIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

facilityRegulatoryProfileRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingProfile, 'facility_regulatory_profile.update'),
  async (req, res) => {
    const result = await updateFacilityRegulatoryProfile(
      profileIdFromParams(req),
      req.body?.jurisdictionCode,
      req.body?.regulatoryAuthorityCode,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

facilityRegulatoryProfileRouter.post(
  '/:id/activate',
  requireOrganizationPermission(organizationIdFromExistingProfile, 'facility_regulatory_profile.activate'),
  async (req, res) => {
    const result = await activateFacilityRegulatoryProfile(profileIdFromParams(req), String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
