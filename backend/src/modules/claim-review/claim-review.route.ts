import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import type { PermissionCode } from '../../shared/authorization/authorization.types.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { organizationIdFromClaim } from '../claim-line/claim-line.route.ts'
import { isPlainObject } from '../claim-line/claim-line.validation.ts'
import { findDecisionOwnership } from './claim-review.repository.ts'
import { getReviewAuthority, getReviewDecision, listReviewDecisions, recordReviewDecision } from './claim-review.service.ts'
import type { ClaimReviewErrorCode, ClaimReviewResult } from './claim-review.types.ts'
import { isClaimReviewUuid } from './claim-review.validation.ts'

// A6.5 §8 — one POST that appends an immutable review decision, a history read, a read-only derived
// authority and one decision read. Ownership resolves through Claim -> Encounter -> Patient -> Organization
// before any work; another tenant's Claim or decision is answered exactly like a missing one (404), and a
// member without the permission receives 403. No PATCH, PUT or DELETE, and no submit, payload or transport
// route; a GET never decides.

export const claimReviewRouter = Router()
export const reviewDecisionRouter = Router()

const statusFor = (code: ClaimReviewErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ClaimReviewResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimReviewUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromDecision(req: Request): Promise<string | null> {
  return (await findDecisionOwnership(String(req.params.decisionId)))?.organizationId ?? null
}

// §4 — withdrawing an approval is its own permission (claimReview.revoke); approve, return and reject need
// claimReview.decide. Anything that is not a REVOKE is checked against claimReview.decide, and the body is
// then validated strictly by the service.
const decisionPermission = (req: Request): PermissionCode => (isPlainObject(req.body) && req.body.decisionCode === 'REVOKE' ? 'claimReview.revoke' : 'claimReview.decide')
const requireDecisionPermission = (req: Request, res: Response, next: NextFunction) => requireMemberPermission(organizationIdFromClaim, decisionPermission(req))(req, res, next)

claimReviewRouter.post('/:claimId/review-decisions', requireUuidParam('claimId', 'claim'), requireDecisionPermission, async (req, res) => {
  send(res, await recordReviewDecision(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 201)
})

claimReviewRouter.get('/:claimId/review-decisions', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimReview.read'), async (req, res) => {
  send(res, await listReviewDecisions(String(req.params.claimId)), 200)
})

claimReviewRouter.get('/:claimId/review-authority', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimReview.read'), async (req, res) => {
  send(res, await getReviewAuthority(String(req.params.claimId)), 200)
})

reviewDecisionRouter.get('/:decisionId', requireUuidParam('decisionId', 'claim review decision'), requireMemberPermission(organizationIdFromDecision, 'claimReview.read'), async (req, res) => {
  send(res, await getReviewDecision(String(req.params.decisionId)), 200)
})
