import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient), as A7.7 and A7.8 resolve it.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getRevenueContinuity } from './revenue-continuity.service.ts'
import type { ContinuityErrorCode } from './revenue-continuity.types.ts'
import { isContinuityUuid, refusedContinuityRequest } from './revenue-continuity.validation.ts'

// A7.9 §5 — exactly one read: the revenue evidence continuity of one Claim, under exactly the A7.7/A7.8 read
// permissions. A malformed id is a safe 400 before any lookup; the session is checked before any domain read; another
// tenant's Claim is answered exactly like a missing one (404); a member lacking any of those reads receives 403; a
// query selector or a body is then a 400. No POST, PUT, PATCH or DELETE, no latest or current selector, no
// all-organization search.

export const continuityRouter = Router()

const statusFor = (code: ContinuityErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireClaimId(req: Request, res: Response, next: NextFunction) {
  if (!isContinuityUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  next()
}

function refuseSelectors(req: Request, res: Response, next: NextFunction) {
  const refused = refusedContinuityRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

continuityRouter.get(
  '/:claimId/revenue-evidence-continuity',
  requireClaimId,
  requireMemberPermission(organizationIdFromClaim, 'claim.read'),
  requireMemberPermission(organizationIdFromClaim, 'claimFreeze.read'),
  requireMemberPermission(organizationIdFromClaim, 'claimCorrection.read'),
  requireMemberPermission(organizationIdFromClaim, 'evidenceCase.read'),
  requireMemberPermission(organizationIdFromClaim, 'evidenceCasePrereq.read'),
  refuseSelectors,
  async (req, res) => {
    const result = await getRevenueContinuity(String(req.params.claimId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
