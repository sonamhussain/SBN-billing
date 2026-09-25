import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import { findEncounterActivityOwnership } from './encounter-activity.repository.ts'
import {
  createEncounterActivity,
  getEncounterActivity,
  listEncounterActivities,
  removeEncounterActivity,
} from './encounter-activity.service.ts'
import type { EncounterActivityErrorCode } from './encounter-activity.types.ts'
import { isEncounterActivityUuid } from './encounter-activity.validation.ts'

// A4.6 §14 — exactly four operations. There is deliberately no PATCH, no DELETE, no restore and no
// claim-line or pricing route.

export const encounterActivitiesRouter = Router()
export const encounterActivityRouter = Router()

function statusFor(code: EncounterActivityErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  // Stored modifiers break the 1..N invariant: the conflict is in the data, not the request.
  if (code === 'INTEGRITY_CONFLICT') return 409
  return 400
}

const encounterIdParam = (req: Request) => String(req.params.encounterId)
const idParam = (req: Request) => String(req.params.id)

// Ownership is resolved before authorization and reads the owning organization ONLY (A4.4's helper
// for the Encounter). No activity, service date or patient data is fetched for an unauthorized
// caller, and a malformed id never reaches the database.
async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const encounterId = encounterIdParam(req)
  if (!isEncounterActivityUuid(encounterId)) return null
  return (await findEncounterOwnership(encounterId))?.organizationId ?? null
}

async function organizationIdFromEncounterActivity(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isEncounterActivityUuid(id)) return null
  return (await findEncounterActivityOwnership(id))?.organizationId ?? null
}

encounterActivitiesRouter.post('/:encounterId/activities', requireOrganizationPermission(organizationIdFromEncounter, 'encounterActivity.create'), async (req, res) => {
  const result = await createEncounterActivity(encounterIdParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(201).json(result.value)
})

encounterActivitiesRouter.get('/:encounterId/activities', requireOrganizationPermission(organizationIdFromEncounter, 'encounterActivity.read'), async (req, res) => {
  const result = await listEncounterActivities(encounterIdParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json({ items: result.value })
})

encounterActivityRouter.get('/:id', requireOrganizationPermission(organizationIdFromEncounterActivity, 'encounterActivity.read'), async (req, res) => {
  const result = await getEncounterActivity(idParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

encounterActivityRouter.post('/:id/remove', requireOrganizationPermission(organizationIdFromEncounterActivity, 'encounterActivity.update'), async (req, res) => {
  const result = await removeEncounterActivity(idParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})
