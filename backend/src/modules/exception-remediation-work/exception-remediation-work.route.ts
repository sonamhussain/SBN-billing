import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getWorkDisposition, getWorkHistory, recordWorkEvent } from './exception-remediation-work.service.ts'
import { READER_PERMISSION, RECORDER_PERMISSION, VERIFIER_PERMISSION, type WorkErrorCode } from './exception-remediation-work.types.ts'
import { isWorkUuid, refusedReadRequest } from './exception-remediation-work.validation.ts'

// A8.6 §5 — exactly three routes on one exception intake of one Claim, under the A8.2 prefix: POST one work event (201)
// under exceptionIntake.read, exceptionTriage.read, exceptionInvestigation.read, exceptionRemediation.read and the
// event's own permission — exceptionRemediationWork.record for a report (the service then requires the current,
// eligible A8.2 assignee) or exceptionRemediationWork.verify for a verification (the service then requires a verifier
// independent of the reporter) — and two read-only GETs, the ordered history and the derived disposition, under the
// four read permissions and exceptionRemediationWork.read (Admin, Viewer). Ownership resolves through the A6.7 path
// before any work; another tenant's Claim is answered exactly like a missing one (404), a member without a permission
// receives 403 and no session 401. No PUT, PATCH or DELETE, no collection, queue, current or sequence selector, and no
// execution, correction, resolution, closure, escalation or export route.

export const exceptionRemediationWorkRouter = Router()

const statusFor = (code: WorkErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' || code === 'UNSUPPORTED_EVIDENCE_KIND' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isWorkUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isWorkUuid(String(req.params.exceptionIntakeId))) {
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
const canReadRemediation = requireMemberPermission(organizationIdFromClaim, 'exceptionRemediation.read')
const canRecord = requireMemberPermission(organizationIdFromClaim, RECORDER_PERMISSION)
const canVerify = requireMemberPermission(organizationIdFromClaim, VERIFIER_PERMISSION)

// The event's own permission. A body that names neither event is left to the validator (400).
function requireEventPermission(req: Request, res: Response, next: NextFunction) {
  const eventCode = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>).eventCode : undefined
  if (eventCode === 'RECORD_WORK_REPORT') return canRecord(req, res, next)
  if (eventCode === 'VERIFY_WORK_REPORT') return canVerify(req, res, next)
  next()
}

exceptionRemediationWorkRouter.post(`${BASE}/remediation-work-events`, requireIds, canReadIntake, canReadTriage, canReadInvestigation, canReadRemediation, requireEventPermission, async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordWorkEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

const canReadWork = requireMemberPermission(organizationIdFromClaim, READER_PERMISSION)

exceptionRemediationWorkRouter.get(`${BASE}/remediation-work-history`, requireIds, canReadIntake, canReadTriage, canReadInvestigation, canReadRemediation, canReadWork, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getWorkHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionRemediationWorkRouter.get(`${BASE}/remediation-work-disposition`, requireIds, canReadIntake, canReadTriage, canReadInvestigation, canReadRemediation, canReadWork, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getWorkDisposition(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
