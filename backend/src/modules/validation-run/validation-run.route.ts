import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership, findFindingOwnership, findRunOwnership } from './validation-run.repository.ts'
import { getValidationFinding, getValidationRun, listValidationFindings, listValidationRuns } from './validation-run.service.ts'
import type { ValidationRunErrorCode } from './validation-run.types.ts'
import { isValidationRunUuid } from './validation-run.validation.ts'

// A5.7 §10 — GET routes only. There is no POST, PATCH, DELETE or /execute route: runs are recorded
// by the internal recorder that A5.8 will call, and A5.8 owns the execution entry point. Ownership is
// resolved through Run -> Encounter -> Patient -> Organization before anything is loaded, so another
// tenant's run or finding is denied without disclosing a code, message or context id.

export const encounterValidationRunsRouter = Router()
export const validationRunRouter = Router()
export const validationFindingRouter = Router()

const statusFor = (code: ValidationRunErrorCode) => (code === 'NOT_FOUND' ? 404 : 400)

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = String(req.params.encounterId)
  if (!isValidationRunUuid(id)) return null
  return (await findEncounterOwnership(id))?.patient.organizationId ?? null
}

async function organizationIdFromRun(req: Request): Promise<string | null> {
  const id = String(req.params.runId)
  if (!isValidationRunUuid(id)) return null
  return (await findRunOwnership(id))?.encounter.patient.organizationId ?? null
}

async function organizationIdFromFinding(req: Request): Promise<string | null> {
  const id = String(req.params.findingId)
  if (!isValidationRunUuid(id)) return null
  return (await findFindingOwnership(id))?.validationRun.encounter.patient.organizationId ?? null
}

encounterValidationRunsRouter.get('/:encounterId/validation-runs', requireOrganizationPermission(organizationIdFromEncounter, 'validationRun.read'), async (req, res) => {
  const result = await listValidationRuns(String(req.params.encounterId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

validationRunRouter.get('/:runId', requireOrganizationPermission(organizationIdFromRun, 'validationRun.read'), async (req, res) => {
  const result = await getValidationRun(String(req.params.runId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

validationRunRouter.get('/:runId/findings', requireOrganizationPermission(organizationIdFromRun, 'validationRun.read'), async (req, res) => {
  const result = await listValidationFindings(String(req.params.runId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

validationFindingRouter.get('/:findingId', requireOrganizationPermission(organizationIdFromFinding, 'validationRun.read'), async (req, res) => {
  const result = await getValidationFinding(String(req.params.findingId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
