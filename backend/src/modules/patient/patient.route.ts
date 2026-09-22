import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findPatientOrganizationId } from './patient.repository.ts'
import { createPatient, getPatient, listPatients, updatePatient } from './patient.service.ts'
import type { PatientErrorCode } from './patient.types.ts'
import { isPatientUuid } from './patient.validation.ts'

// A4.1 §10 — exactly four routes. There is deliberately no DELETE route (retention and deletion
// remain externally governed), no name search, and no insurance, encounter or external-identifier
// sub-route: those belong to A4.3, A4.4 and A4.8.

export const organizationPatientRouter = Router()
export const patientRouter = Router()

function statusFor(code: PatientErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

const idParam = (req: Request) => String(req.params.id)
const organizationIdParam = (req: Request) => String(req.params.organizationId)

// By-ID routes resolve the owning organization before authorization, so a foreign-tenant patient is
// denied by the existing privacy-safe pattern. The lookup reads ownership ONLY — no demographic
// column is fetched for a caller who has not been authorized yet, and a malformed id never reaches
// the database at all.
async function organizationIdFromPatient(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isPatientUuid(id)) return null
  const ownership = await findPatientOrganizationId(id)
  return ownership?.organizationId ?? null
}

organizationPatientRouter.post(
  '/:organizationId/patients',
  requireOrganizationPermission(organizationIdParam, 'patient.create'),
  async (req, res) => {
    const result = await createPatient(organizationIdParam(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

organizationPatientRouter.get(
  '/:organizationId/patients',
  requireOrganizationPermission(organizationIdParam, 'patient.read'),
  async (req, res) => {
    const result = await listPatients(organizationIdParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

patientRouter.get('/:id', requireOrganizationPermission(organizationIdFromPatient, 'patient.read'), async (req, res) => {
  const result = await getPatient(idParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

patientRouter.patch('/:id', requireOrganizationPermission(organizationIdFromPatient, 'patient.update'), async (req, res) => {
  const result = await updatePatient(idParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})
