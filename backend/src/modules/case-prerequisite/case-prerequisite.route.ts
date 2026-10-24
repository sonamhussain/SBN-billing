import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A7.4 ownership path of a case snapshot (stored organization, held equal to its frozen submission's).
import { findCaseOwnership } from '../evidence-case/evidence-case.repository.ts'
import { findAssessmentOwnership } from './case-prerequisite.repository.ts'
import { assessClosurePrerequisites, getClosurePrerequisiteAssessment, listClosurePrerequisiteAssessments } from './case-prerequisite.service.ts'
import type { AssessmentErrorCode, AssessmentResult } from './case-prerequisite.types.ts'
import { isPrerequisiteUuid } from './case-prerequisite.validation.ts'

// A7.5 §6 — one POST that records the server-derived closure-prerequisite assessment of one exact case snapshot (201
// new, 200 exact replay), the case's assessment history and one assessment read. Ownership resolves through the A7.4
// path before any work; another tenant's case or assessment is answered exactly like a missing one (404), a member
// without the permission receives 403 and no session 401. No DELETE, PATCH or PUT, no latest or per-Claim selector,
// and no adjudication, payment, posting, reconciliation, closure, balance or payer-response route.

export const caseAssessmentRouter = Router()
export const prerequisiteAssessmentRouter = Router()

const statusFor = (code: AssessmentErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: AssessmentResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup; no query string is ever read.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isPrerequisiteUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromCase(req: Request): Promise<string | null> {
  return (await findCaseOwnership(String(req.params.caseId).toLowerCase()))?.organizationId ?? null
}

async function organizationIdFromAssessment(req: Request): Promise<string | null> {
  return (await findAssessmentOwnership(String(req.params.assessmentId).toLowerCase()))?.organizationId ?? null
}

caseAssessmentRouter.post(
  '/:caseId/closure-prerequisite-assessments',
  requireUuidParam('caseId', 'revenue evidence case'),
  requireMemberPermission(organizationIdFromCase, 'evidenceCasePrereq.create'),
  async (req, res) => {
    const result = await assessClosurePrerequisites(String(req.params.caseId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      send(res, result, 201)
      return
    }
    // The same stored assessment either way: 201 when new, 200 for the exact replay.
    res.status(result.value.replayed ? 200 : 201).json(result.value.assessment)
  },
)

caseAssessmentRouter.get(
  '/:caseId/closure-prerequisite-assessments',
  requireUuidParam('caseId', 'revenue evidence case'),
  requireMemberPermission(organizationIdFromCase, 'evidenceCasePrereq.read'),
  async (req, res) => {
    send(res, await listClosurePrerequisiteAssessments(String(req.params.caseId)), 200)
  },
)

prerequisiteAssessmentRouter.get(
  '/:assessmentId',
  requireUuidParam('assessmentId', 'closure-prerequisite assessment'),
  requireMemberPermission(organizationIdFromAssessment, 'evidenceCasePrereq.read'),
  async (req, res) => {
    send(res, await getClosurePrerequisiteAssessment(String(req.params.assessmentId)), 200)
  },
)
