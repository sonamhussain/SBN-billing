import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findAssessmentOwnership } from '../pre-claim-readiness/pre-claim-readiness.repository.ts'
import { findEncounterOwnership } from '../validation-run/validation-run.repository.ts'
import { findClaimOwnership } from './claim.repository.ts'
import { createClaim, getClaim, listClaimsForEncounter } from './claim.service.ts'
import type { ClaimErrorCode } from './claim.types.ts'
import { isClaimUuid } from './claim.validation.ts'

// A6.1 §9/§10/§11 — one POST that creates a Claim from an exact readiness assessment (Admin only) and
// two GETs. There is no PATCH, PUT or DELETE, and no approve, submit or transmit route. Ownership
// resolves through the assessment chain before creation and through Claim -> Encounter -> Patient ->
// Organization for reads, so another tenant's assessment or Claim is denied without disclosing a state,
// finding or context id.

export const assessmentClaimRouter = Router()
export const claimRouter = Router()
export const encounterClaimRouter = Router()

const statusFor = (code: ClaimErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

// §9 — a malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromAssessment(req: Request): Promise<string | null> {
  return (await findAssessmentOwnership(String(req.params.assessmentId)))?.validationRun.encounter.patient.organizationId ?? null
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimOwnership(String(req.params.claimId)))?.encounter.patient.organizationId ?? null
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  return (await findEncounterOwnership(String(req.params.encounterId)))?.patient.organizationId ?? null
}

assessmentClaimRouter.post(
  '/:assessmentId/claims',
  requireUuidParam('assessmentId', 'readiness assessment'),
  requireOrganizationPermission(organizationIdFromAssessment, 'claim.create'),
  async (req, res) => {
    const result = await createClaim(String(req.params.assessmentId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

claimRouter.get('/:claimId', requireUuidParam('claimId', 'claim'), requireOrganizationPermission(organizationIdFromClaim, 'claim.read'), async (req, res) => {
  const result = await getClaim(String(req.params.claimId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

encounterClaimRouter.get(
  '/:encounterId/claims',
  requireUuidParam('encounterId', 'encounter'),
  requireOrganizationPermission(organizationIdFromEncounter, 'claim.read'),
  async (req, res) => {
    const result = await listClaimsForEncounter(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
