import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import {
  findClinicianOwnership,
  findFacilityAssignmentOwnership,
  findSpecialtyAssignmentOwnership,
} from './clinician-assignment.repository.ts'
import {
  closeFacilityAssignment,
  closeSpecialtyAssignment,
  createFacilityAssignment,
  createSpecialtyAssignment,
  getFacilityAssignment,
  getSpecialtyAssignment,
  listFacilityAssignments,
  listSpecialtyAssignments,
} from './clinician-assignment.service.ts'
import type { ClinicianAssignmentErrorCode } from './clinician-assignment.types.ts'
import { isAssignmentUuid } from './clinician-assignment.validation.ts'

// A4.2 §13 — exactly eight routes, four per assignment type: create, list, get and close. There is
// deliberately no PATCH (a recorded period is not rewritten), no DELETE (history is kept), no bulk
// replace and no "set primary specialty" route.

export const clinicianAssignmentRouter = Router()
export const facilityAssignmentRouter = Router()
export const specialtyAssignmentRouter = Router()

function statusFor(code: ClinicianAssignmentErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

const idParam = (req: Request) => String(req.params.id)
const clinicianIdParam = (req: Request) => String(req.params.clinicianId)

// Ownership is resolved from the clinician, reading the organization column only — nothing about
// the clinician, facility or specialty is fetched for a caller who is not yet authorized.
async function organizationIdFromClinician(req: Request): Promise<string | null> {
  const id = clinicianIdParam(req)
  if (!isAssignmentUuid(id)) return null
  const clinician = await findClinicianOwnership(id)
  return clinician?.organizationId ?? null
}

async function organizationIdFromFacilityAssignment(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isAssignmentUuid(id)) return null
  const assignment = await findFacilityAssignmentOwnership(id)
  return assignment?.clinician.organizationId ?? null
}

async function organizationIdFromSpecialtyAssignment(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isAssignmentUuid(id)) return null
  const assignment = await findSpecialtyAssignmentOwnership(id)
  return assignment?.clinician.organizationId ?? null
}

// ---- /api/clinicians/:clinicianId/... --------------------------------------------------------

clinicianAssignmentRouter.post(
  '/:clinicianId/facility-assignments',
  requireOrganizationPermission(organizationIdFromClinician, 'clinicianAssignment.create'),
  async (req, res) => {
    const result = await createFacilityAssignment(clinicianIdParam(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

clinicianAssignmentRouter.get(
  '/:clinicianId/facility-assignments',
  requireOrganizationPermission(organizationIdFromClinician, 'clinicianAssignment.read'),
  async (req, res) => {
    const result = await listFacilityAssignments(clinicianIdParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

clinicianAssignmentRouter.post(
  '/:clinicianId/specialty-assignments',
  requireOrganizationPermission(organizationIdFromClinician, 'clinicianAssignment.create'),
  async (req, res) => {
    const result = await createSpecialtyAssignment(clinicianIdParam(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

clinicianAssignmentRouter.get(
  '/:clinicianId/specialty-assignments',
  requireOrganizationPermission(organizationIdFromClinician, 'clinicianAssignment.read'),
  async (req, res) => {
    const result = await listSpecialtyAssignments(clinicianIdParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

// ---- /api/clinician-facility-assignments/:id -------------------------------------------------

facilityAssignmentRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromFacilityAssignment, 'clinicianAssignment.read'),
  async (req, res) => {
    const result = await getFacilityAssignment(idParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

facilityAssignmentRouter.post(
  '/:id/close',
  requireOrganizationPermission(organizationIdFromFacilityAssignment, 'clinicianAssignment.close'),
  async (req, res) => {
    const result = await closeFacilityAssignment(idParam(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

// ---- /api/clinician-specialty-assignments/:id ------------------------------------------------

specialtyAssignmentRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromSpecialtyAssignment, 'clinicianAssignment.read'),
  async (req, res) => {
    const result = await getSpecialtyAssignment(idParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

specialtyAssignmentRouter.post(
  '/:id/close',
  requireOrganizationPermission(organizationIdFromSpecialtyAssignment, 'clinicianAssignment.close'),
  async (req, res) => {
    const result = await closeSpecialtyAssignment(idParam(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)
