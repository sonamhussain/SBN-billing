import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The ownership path of an assessment: its A7.4 case -> A6.7 frozen submission -> Claim -> Encounter -> Patient
// organization, through the A7.5 owner's reads.
import { findAssessmentById, findCaseForPrerequisite } from '../case-prerequisite/case-prerequisite.repository.ts'
import { getClosureBasisTrace } from './closure-basis-trace.service.ts'
import type { TraceErrorCode } from './closure-basis-trace.types.ts'
import { isTraceUuid } from './closure-basis-trace.validation.ts'

// A7.6 §4 — exactly one read: the basis trace of one exact assessment. Ownership resolves through the case chain
// before any work; another tenant's assessment is answered exactly like a missing one (404), a member without the
// read permission receives 403 and no session 401. No POST, PUT, PATCH or DELETE, no latest or per-Claim scan, and
// no query parameter is ever read.

export const basisTraceRouter = Router()

const statusFor = (code: TraceErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

// A malformed id is a safe 400 before any lookup.
function requireAssessmentId(req: Request, res: Response, next: NextFunction) {
  if (!isTraceUuid(String(req.params.assessmentId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid closure-prerequisite assessment id')
    return
  }
  next()
}

async function organizationIdFromAssessmentChain(req: Request): Promise<string | null> {
  const assessment = await findAssessmentById(String(req.params.assessmentId).toLowerCase())
  if (!assessment) return null
  return (await findCaseForPrerequisite(assessment.evidenceCaseId, prisma))?.submissionOrganizationId ?? null
}

basisTraceRouter.get('/:assessmentId/basis-trace', requireAssessmentId, requireMemberPermission(organizationIdFromAssessmentChain, 'evidenceCasePrereq.read'), async (req, res) => {
  const result = await getClosureBasisTrace(String(req.params.assessmentId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
