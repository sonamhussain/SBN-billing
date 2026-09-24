import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership, findPatientOwnership } from './encounter.repository.ts'
import { createEncounter, getEncounter, listEncounters, updateEncounter } from './encounter.service.ts'
import type { EncounterErrorCode } from './encounter.types.ts'
import { isEncounterUuid } from './encounter.validation.ts'

// A4.4 §13 — exactly four routes. There is deliberately no DELETE (history is kept), no
// eligibility/authorization route, no diagnosis/activity sub-route and no submit/claim route.

export const patientEncounterRouter = Router()
export const encounterRouter = Router()

function statusFor(code: EncounterErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

const idParam = (req: Request) => String(req.params.id)
const patientIdParam = (req: Request) => String(req.params.patientId)

// Ownership is resolved before authorization and reads the owning organization ONLY — no service
// date, provider, membership or context ID is fetched for a caller who is not yet authorized. A
// malformed id returns before any database lookup.
async function organizationIdFromPatient(req: Request): Promise<string | null> {
  const id = patientIdParam(req)
  if (!isEncounterUuid(id)) return null
  return (await findPatientOwnership(id))?.organizationId ?? null
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isEncounterUuid(id)) return null
  return (await findEncounterOwnership(id))?.organizationId ?? null
}

patientEncounterRouter.post('/:patientId/encounters', requireOrganizationPermission(organizationIdFromPatient, 'encounter.create'), async (req, res) => {
  const result = await createEncounter(patientIdParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(201).json(result.value)
})

patientEncounterRouter.get('/:patientId/encounters', requireOrganizationPermission(organizationIdFromPatient, 'encounter.read'), async (req, res) => {
  const result = await listEncounters(patientIdParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json({ items: result.value })
})

encounterRouter.get('/:id', requireOrganizationPermission(organizationIdFromEncounter, 'encounter.read'), async (req, res) => {
  const result = await getEncounter(idParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

encounterRouter.patch('/:id', requireOrganizationPermission(organizationIdFromEncounter, 'encounter.update'), async (req, res) => {
  const result = await updateEncounter(idParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})
