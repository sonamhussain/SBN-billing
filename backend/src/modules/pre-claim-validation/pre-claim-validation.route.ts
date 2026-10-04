import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership } from '../validation-run/validation-run.repository.ts'
import { isValidationRunUuid } from '../validation-run/validation-run.validation.ts'
import { executePreClaimValidation } from './pre-claim-validation.service.ts'
import type { PreClaimValidationErrorCode } from './pre-claim-validation.types.ts'

// A5.8 §18–§19 — the only production write entry for validation history. Admin only
// (preClaimValidation.execute); a Viewer reads runs through A5.7. Ownership resolves Encounter ->
// Patient -> Organization before anything executes, so a foreign Encounter is denied without running.

export const encounterPreClaimValidationRouter = Router()

const statusFor = (code: PreClaimValidationErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'INTEGRITY_CONFLICT' ? 409 : 400)

// §26 T09 — a malformed Encounter id is a safe 400 before any lookup.
function requireEncounterUuid(req: Request, res: Response, next: NextFunction) {
  if (!isValidationRunUuid(String(req.params.encounterId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid encounter id')
    return
  }
  next()
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  return (await findEncounterOwnership(String(req.params.encounterId)))?.patient.organizationId ?? null
}

encounterPreClaimValidationRouter.post(
  '/:encounterId/pre-claim-validation/execute',
  requireEncounterUuid,
  requireOrganizationPermission(organizationIdFromEncounter, 'preClaimValidation.execute'),
  async (req, res) => {
    const result = await executePreClaimValidation(String(req.params.encounterId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)
