import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getEscalationDisposition, getEscalationHistory, recordEscalationEvent } from './exception-escalation.service.ts'
import { type EscalationErrorCode, HANDLE_PERMISSION, PARENT_READ_PERMISSIONS, RAISE_PERMISSION, READER_PERMISSION, REVIEW_PERMISSION } from './exception-escalation.types.ts'
import { isEscalationUuid, refusedReadRequest } from './exception-escalation.validation.ts'

// A8.8 §4 — exactly three routes on one exception intake of one Claim, under the A8.2 prefix: POST one escalation event
// (201) under all six upstream read permissions — exceptionIntake.read, exceptionTriage.read,
// exceptionInvestigation.read, exceptionRemediation.read, exceptionRemediationWork.read and exceptionResolution.read —
// and the event's own permission: exceptionEscalation.raise for an escalation (the service then requires the current,
// eligible A8.2 assignee), exceptionEscalation.handle for an acknowledgement or follow-up (the service then requires the
// nominated member), or exceptionEscalation.review for a return (the service then requires a reviewer independent of the
// escalator, the nominated member and the current assignee); and two read-only GETs, the ordered history and the derived
// disposition, under the six read permissions and exceptionEscalation.read (Admin, Viewer). Ownership resolves through
// the A6.7 path before any work; another tenant's Claim is answered exactly like a missing one (404), a member without a
// permission receives 403 and no session 401. No PUT, PATCH or DELETE, no collection, list-all, search, queue, job, SLA,
// timer, current or sequence selector, and no resolution, closure, reopen, execution, claim adjustment, release, export,
// payer or transmission route.

export const exceptionEscalationRouter = Router()

const statusFor = (code: EscalationErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isEscalationUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isEscalationUuid(String(req.params.exceptionIntakeId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid exception intake id')
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

const BASE = '/:claimId/exceptions/:exceptionIntakeId'
// The six upstream read permissions, in owner order (A8.1, A8.2, A8.3, A8.5, A8.6, A8.7).
const canReadParents = PARENT_READ_PERMISSIONS.map((permission) => requireMemberPermission(organizationIdFromClaim, permission))
const canRaise = requireMemberPermission(organizationIdFromClaim, RAISE_PERMISSION)
const canHandle = requireMemberPermission(organizationIdFromClaim, HANDLE_PERMISSION)
const canReview = requireMemberPermission(organizationIdFromClaim, REVIEW_PERMISSION)

// The event's own permission. A body that names no controlled event is left to the validator (400).
function requireEventPermission(req: Request, res: Response, next: NextFunction) {
  const eventCode = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>).eventCode : undefined
  if (eventCode === 'ESCALATE_FOR_REVIEW') return canRaise(req, res, next)
  if (eventCode === 'ACKNOWLEDGE_ESCALATION' || eventCode === 'RECORD_FOLLOWUP') return canHandle(req, res, next)
  if (eventCode === 'RETURN_TO_OWNER') return canReview(req, res, next)
  next()
}

exceptionEscalationRouter.post(`${BASE}/escalation-events`, requireIds, ...canReadParents, requireEventPermission, async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordEscalationEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

const canReadEscalation = requireMemberPermission(organizationIdFromClaim, READER_PERMISSION)

exceptionEscalationRouter.get(`${BASE}/escalation-history`, requireIds, ...canReadParents, canReadEscalation, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getEscalationHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionEscalationRouter.get(`${BASE}/escalation-disposition`, requireIds, ...canReadParents, canReadEscalation, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getEscalationDisposition(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
