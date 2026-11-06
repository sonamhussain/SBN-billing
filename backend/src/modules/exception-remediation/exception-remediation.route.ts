import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getRemediationDisposition, getRemediationHistory, recordRemediationEvent } from './exception-remediation.service.ts'
import { PROPOSER_PERMISSION, REVIEWER_PERMISSION, type RemediationErrorCode } from './exception-remediation.types.ts'
import { isRemediationUuid, refusedReadRequest } from './exception-remediation.validation.ts'

// A8.5 §6 — exactly three routes on one exception intake of one Claim, under the A8.2 prefix: POST one remediation
// event (201) under exceptionIntake.read, exceptionTriage.read, exceptionInvestigation.read and the event's own
// permission — exceptionRemediation.propose for a proposal (the service then requires the current, eligible A8.2
// assignee) or exceptionRemediation.review for a review (the service then requires an independent reviewer) — and two
// read-only GETs, the ordered history and the derived disposition, under the three read permissions and
// exceptionRemediation.read (Admin, Viewer). Ownership resolves through the A6.7 path before any work; another
// tenant's Claim is answered exactly like a missing one (404), a member without a permission receives 403 and no
// session 401. No PUT, PATCH or DELETE, no collection or cross-Claim search or queue, and no execution, correction,
// resolution, closure, escalation or export route.

export const exceptionRemediationRouter = Router()

const statusFor = (code: RemediationErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isRemediationUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isRemediationUuid(String(req.params.exceptionIntakeId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid exception intake id')
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

const BASE = '/:claimId/exceptions/:exceptionIntakeId'
const canReadIntake = requireMemberPermission(organizationIdFromClaim, 'exceptionIntake.read')
const canReadTriage = requireMemberPermission(organizationIdFromClaim, 'exceptionTriage.read')
const canReadInvestigation = requireMemberPermission(organizationIdFromClaim, 'exceptionInvestigation.read')
const canPropose = requireMemberPermission(organizationIdFromClaim, PROPOSER_PERMISSION)
const canReview = requireMemberPermission(organizationIdFromClaim, REVIEWER_PERMISSION)

// The event's own permission. A body that names neither event is left to the validator (400).
function requireEventPermission(req: Request, res: Response, next: NextFunction) {
  const eventCode = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>).eventCode : undefined
  if (eventCode === 'PROPOSE_ACTION') return canPropose(req, res, next)
  if (eventCode === 'REVIEW_ACTION') return canReview(req, res, next)
  next()
}

exceptionRemediationRouter.post(`${BASE}/remediation-events`, requireIds, canReadIntake, canReadTriage, canReadInvestigation, requireEventPermission, async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordRemediationEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

const canReadRemediation = requireMemberPermission(organizationIdFromClaim, 'exceptionRemediation.read')

exceptionRemediationRouter.get(`${BASE}/remediation-history`, requireIds, canReadIntake, canReadTriage, canReadInvestigation, canReadRemediation, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getRemediationHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionRemediationRouter.get(`${BASE}/remediation-disposition`, requireIds, canReadIntake, canReadTriage, canReadInvestigation, canReadRemediation, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getRemediationDisposition(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
