import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getRevenueTimeline } from './revenue-timeline.service.ts'
import type { TimelineErrorCode } from './revenue-timeline.types.ts'
import { isTimelineUuid, refusedRequestShape } from './revenue-timeline.validation.ts'

// A7.7 §5 — exactly one read: the revenue evidence timeline of one Claim. A malformed id is a safe 400 before any
// lookup; the session is checked before any domain read; another tenant's Claim is answered exactly like a missing
// one (404); a member lacking any read permission for the data the timeline shows (Claim, freezes, correction links,
// cases, assessments) receives 403; a query selector or a body is then a 400. No POST, PUT, PATCH or DELETE, no
// latest or current selector, and no all-organization search.

export const timelineRouter = Router()

const statusFor = (code: TimelineErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireClaimId(req: Request, res: Response, next: NextFunction) {
  if (!isTimelineUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  next()
}

function refuseSelectors(req: Request, res: Response, next: NextFunction) {
  const refused = refusedRequestShape(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

timelineRouter.get(
  '/:claimId/revenue-evidence-timeline',
  requireClaimId,
  requireMemberPermission(organizationIdFromClaim, 'claim.read'),
  requireMemberPermission(organizationIdFromClaim, 'claimFreeze.read'),
  requireMemberPermission(organizationIdFromClaim, 'claimCorrection.read'),
  requireMemberPermission(organizationIdFromClaim, 'evidenceCase.read'),
  requireMemberPermission(organizationIdFromClaim, 'evidenceCasePrereq.read'),
  refuseSelectors,
  async (req, res) => {
    const result = await getRevenueTimeline(String(req.params.claimId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
