import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import { findEncounterDiagnosisOwnership } from './encounter-diagnosis.repository.ts'
import {
  addEncounterDiagnosis,
  listEncounterDiagnoses,
  removeEncounterDiagnosis,
  reorderEncounterDiagnoses,
} from './encounter-diagnosis.service.ts'
import type { EncounterDiagnosisErrorCode } from './encounter-diagnosis.types.ts'
import { isEncounterDiagnosisUuid } from './encounter-diagnosis.validation.ts'

// A4.5 §11 — exactly four operations. There is deliberately no DELETE, no general PATCH, no
// client-supplied sequence on create and no restore route.

export const encounterDiagnosesRouter = Router()
export const encounterDiagnosisRouter = Router()

function statusFor(code: EncounterDiagnosisErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  // Stored state breaks the active-order invariant: the conflict is in the data, not the request.
  if (code === 'INTEGRITY_CONFLICT') return 409
  return 400
}

const encounterIdParam = (req: Request) => String(req.params.encounterId)
const idParam = (req: Request) => String(req.params.id)

// Ownership is resolved before authorization and reads the owning organization ONLY (A4.4's helper
// for the Encounter). No diagnosis, service date or patient data is fetched for an unauthorized
// caller, and a malformed id never reaches the database.
async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const encounterId = encounterIdParam(req)
  if (!isEncounterDiagnosisUuid(encounterId)) return null
  return (await findEncounterOwnership(encounterId))?.organizationId ?? null
}

async function organizationIdFromEncounterDiagnosis(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isEncounterDiagnosisUuid(id)) return null
  return (await findEncounterDiagnosisOwnership(id))?.organizationId ?? null
}

encounterDiagnosesRouter.post('/:encounterId/diagnoses', requireOrganizationPermission(organizationIdFromEncounter, 'encounterDiagnosis.create'), async (req, res) => {
  const result = await addEncounterDiagnosis(encounterIdParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(201).json(result.value)
})

encounterDiagnosesRouter.get('/:encounterId/diagnoses', requireOrganizationPermission(organizationIdFromEncounter, 'encounterDiagnosis.read'), async (req, res) => {
  const result = await listEncounterDiagnoses(encounterIdParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json({ items: result.value })
})

encounterDiagnosesRouter.put('/:encounterId/diagnoses/order', requireOrganizationPermission(organizationIdFromEncounter, 'encounterDiagnosis.update'), async (req, res) => {
  const result = await reorderEncounterDiagnoses(encounterIdParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json({ items: result.value })
})

encounterDiagnosisRouter.post('/:id/remove', requireOrganizationPermission(organizationIdFromEncounterDiagnosis, 'encounterDiagnosis.update'), async (req, res) => {
  const result = await removeEncounterDiagnosis(idParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json({ items: result.value })
})
