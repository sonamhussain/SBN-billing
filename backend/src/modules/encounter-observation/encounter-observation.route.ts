import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import { findEncounterObservationOwnership } from './encounter-observation.repository.ts'
import {
  createEncounterObservation,
  getEncounterObservation,
  listEncounterObservations,
  removeEncounterObservation,
} from './encounter-observation.service.ts'
import type { EncounterObservationErrorCode } from './encounter-observation.types.ts'
import { isEncounterObservationUuid } from './encounter-observation.validation.ts'

// A4.7 §12 — exactly four operations. There is deliberately no PATCH, DELETE, restore, evaluate or
// search route, and no activity-specific write route: the activity is an optional anchor in the
// create body.

export const encounterObservationsRouter = Router()
export const encounterObservationRouter = Router()

function statusFor(code: EncounterObservationErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  // A stored row breaks the typed-value invariant: the conflict is in the data, not the request.
  if (code === 'INTEGRITY_CONFLICT') return 409
  return 400
}

const encounterIdParam = (req: Request) => String(req.params.encounterId)
const idParam = (req: Request) => String(req.params.id)

// Ownership is resolved before authorization and reads the owning organization ONLY (A4.4's helper
// for the Encounter). No fact, value or patient data is fetched for an unauthorized caller, and a
// malformed id never reaches the database.
async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const encounterId = encounterIdParam(req)
  if (!isEncounterObservationUuid(encounterId)) return null
  return (await findEncounterOwnership(encounterId))?.organizationId ?? null
}

async function organizationIdFromEncounterObservation(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isEncounterObservationUuid(id)) return null
  return (await findEncounterObservationOwnership(id))?.organizationId ?? null
}

encounterObservationsRouter.post('/:encounterId/observations', requireOrganizationPermission(organizationIdFromEncounter, 'encounterObservation.create'), async (req, res) => {
  const result = await createEncounterObservation(encounterIdParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(201).json(result.value)
})

encounterObservationsRouter.get('/:encounterId/observations', requireOrganizationPermission(organizationIdFromEncounter, 'encounterObservation.read'), async (req, res) => {
  const result = await listEncounterObservations(encounterIdParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json({ items: result.value })
})

encounterObservationRouter.get('/:id', requireOrganizationPermission(organizationIdFromEncounterObservation, 'encounterObservation.read'), async (req, res) => {
  const result = await getEncounterObservation(idParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

encounterObservationRouter.post('/:id/remove', requireOrganizationPermission(organizationIdFromEncounterObservation, 'encounterObservation.update'), async (req, res) => {
  const result = await removeEncounterObservation(idParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})
