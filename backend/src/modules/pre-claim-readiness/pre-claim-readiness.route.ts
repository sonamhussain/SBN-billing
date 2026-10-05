import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership, findRunOwnership } from '../validation-run/validation-run.repository.ts'
import { findAssessmentOwnership } from './pre-claim-readiness.repository.ts'
import { getA6Handoff, getReadinessAssessment, listReadinessAssessments, recordReadinessAssessment } from './pre-claim-readiness.service.ts'
import type { PreClaimReadinessErrorCode } from './pre-claim-readiness.types.ts'
import { isReadinessUuid } from './pre-claim-readiness.validation.ts'

// A5.9 §7/§15/§16 — one POST that records an assessment (Admin only) and three GETs. There is no
// PATCH, DELETE, /approve, /submit or Claim route. Ownership resolves ValidationRun -> Encounter ->
// Patient -> Organization before anything is loaded, so another tenant's run, assessment or handoff
// is denied without disclosing a state, finding code or context id.

export const validationRunReadinessRouter = Router()
export const encounterReadinessRouter = Router()
export const readinessAssessmentRouter = Router()

const statusFor = (code: PreClaimReadinessErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

// §23 T49 — a malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isReadinessUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromRun(req: Request): Promise<string | null> {
  return (await findRunOwnership(String(req.params.runId)))?.encounter.patient.organizationId ?? null
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  return (await findEncounterOwnership(String(req.params.encounterId)))?.patient.organizationId ?? null
}

async function organizationIdFromAssessment(req: Request): Promise<string | null> {
  return (await findAssessmentOwnership(String(req.params.assessmentId)))?.validationRun.encounter.patient.organizationId ?? null
}

validationRunReadinessRouter.post(
  '/:runId/readiness-assessments',
  requireUuidParam('runId', 'validation run'),
  requireOrganizationPermission(organizationIdFromRun, 'preClaimReadiness.evaluate'),
  async (req, res) => {
    const result = await recordReadinessAssessment(String(req.params.runId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

encounterReadinessRouter.get(
  '/:encounterId/pre-claim-readiness-assessments',
  requireUuidParam('encounterId', 'encounter'),
  requireOrganizationPermission(organizationIdFromEncounter, 'preClaimReadiness.read'),
  async (req, res) => {
    const result = await listReadinessAssessments(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

readinessAssessmentRouter.get(
  '/:assessmentId',
  requireUuidParam('assessmentId', 'readiness assessment'),
  requireOrganizationPermission(organizationIdFromAssessment, 'preClaimReadiness.read'),
  async (req, res) => {
    const result = await getReadinessAssessment(String(req.params.assessmentId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

readinessAssessmentRouter.get(
  '/:assessmentId/a6-handoff',
  requireUuidParam('assessmentId', 'readiness assessment'),
  requireOrganizationPermission(organizationIdFromAssessment, 'preClaimA6Handoff.read'),
  async (req, res) => {
    const result = await getA6Handoff(String(req.params.assessmentId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
