import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getResolutionDisposition, getResolutionHistory, recordResolutionEvent } from './exception-resolution.service.ts'
import { DECIDER_PERMISSION, PARENT_READ_PERMISSIONS, READER_PERMISSION, REQUESTER_PERMISSION, type ResolutionErrorCode } from './exception-resolution.types.ts'
import { isResolutionUuid, refusedReadRequest } from './exception-resolution.validation.ts'

// A8.7 §6 — exactly three routes on one exception intake of one Claim, under the A8.2 prefix: POST one resolution event
// (201) under all five upstream read permissions — exceptionIntake.read, exceptionTriage.read,
// exceptionInvestigation.read, exceptionRemediation.read and exceptionRemediationWork.read — and the event's own
// permission: exceptionResolution.request for a request (the service then requires the current, eligible A8.2 assignee)
// or exceptionResolution.decide for a decision (the service then requires a decider independent of the requester); and
// two read-only GETs, the ordered history and the derived disposition, under the five read permissions and
// exceptionResolution.read (Admin, Viewer). Ownership resolves through the A6.7 path before any work; another tenant's
// Claim is answered exactly like a missing one (404), a member without a permission receives 403 and no session 401.
// No PUT, PATCH or DELETE, no collection, queue, current or sequence selector, and no execution, correction, closure,
// escalation, SLA, export, payer or transmission route.

export const exceptionResolutionRouter = Router()

const statusFor = (code: ResolutionErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isResolutionUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isResolutionUuid(String(req.params.exceptionIntakeId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid exception intake id')
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

const BASE = '/:claimId/exceptions/:exceptionIntakeId'
// The five upstream read permissions, in owner order (A8.1, A8.2, A8.3, A8.5, A8.6).
const canReadParents = PARENT_READ_PERMISSIONS.map((permission) => requireMemberPermission(organizationIdFromClaim, permission))
const canRequest = requireMemberPermission(organizationIdFromClaim, REQUESTER_PERMISSION)
const canDecide = requireMemberPermission(organizationIdFromClaim, DECIDER_PERMISSION)

// The event's own permission. A body that names neither event is left to the validator (400).
function requireEventPermission(req: Request, res: Response, next: NextFunction) {
  const eventCode = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>).eventCode : undefined
  if (eventCode === 'REQUEST_INTERNAL_RESOLUTION') return canRequest(req, res, next)
  if (eventCode === 'DECIDE_INTERNAL_RESOLUTION') return canDecide(req, res, next)
  next()
}

exceptionResolutionRouter.post(`${BASE}/resolution-events`, requireIds, ...canReadParents, requireEventPermission, async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordResolutionEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

const canReadResolution = requireMemberPermission(organizationIdFromClaim, READER_PERMISSION)

exceptionResolutionRouter.get(`${BASE}/resolution-history`, requireIds, ...canReadParents, canReadResolution, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getResolutionHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionResolutionRouter.get(`${BASE}/resolution-disposition`, requireIds, ...canReadParents, canReadResolution, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getResolutionDisposition(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
