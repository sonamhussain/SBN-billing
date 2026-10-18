import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a frozen submission (Submission -> Claim -> Encounter -> Patient ->
// Organization), reused unchanged.
import { findFreezeOwnership } from '../claim-submission/claim-submission.repository.ts'
import { getLifecycleState, listLifecycleEvents, recordLifecycleEvent } from './claim-lifecycle.service.ts'
import type { ClaimLifecycleErrorCode, ClaimLifecycleResult } from './claim-lifecycle.types.ts'
import { isClaimLifecycleUuid } from './claim-lifecycle.validation.ts'

// A6.8 §5 — one POST that appends an explicit internal lifecycle event, a history read and a derived
// disposition read, all under /api/claim-submissions/:submissionId. Ownership resolves through the A6.7
// path before any work; another tenant's submission is answered exactly like a missing one (404), a member
// without the permission receives 403 and no session 401. No status PATCH/PUT, no DELETE and no send
// route; frozen bytes and manifests are never returned here.

export const claimLifecycleRouter = Router()

const statusFor = (code: ClaimLifecycleErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ClaimLifecycleResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireSubmissionId = (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimLifecycleUuid(String(req.params.submissionId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim submission id')
    return
  }
  next()
}

async function organizationIdFromSubmission(req: Request): Promise<string | null> {
  return (await findFreezeOwnership(String(req.params.submissionId).toLowerCase()))?.organizationId ?? null
}

claimLifecycleRouter.post('/:submissionId/lifecycle-events', requireSubmissionId, requireMemberPermission(organizationIdFromSubmission, 'claimLifecycle.record'), async (req, res) => {
  send(res, await recordLifecycleEvent(String(req.params.submissionId), req.body, String(res.locals.actorUserId)), 201)
})

claimLifecycleRouter.get('/:submissionId/lifecycle-events', requireSubmissionId, requireMemberPermission(organizationIdFromSubmission, 'claimLifecycle.read'), async (req, res) => {
  send(res, await listLifecycleEvents(String(req.params.submissionId)), 200)
})

claimLifecycleRouter.get('/:submissionId/lifecycle', requireSubmissionId, requireMemberPermission(organizationIdFromSubmission, 'claimLifecycle.read'), async (req, res) => {
  send(res, await getLifecycleState(String(req.params.submissionId)), 200)
})
