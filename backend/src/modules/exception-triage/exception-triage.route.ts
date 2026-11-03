import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getTriageDisposition, getTriageHistory, recordTriageEvent } from './exception-triage.service.ts'
import type { TriageErrorCode } from './exception-triage.types.ts'
import { isTriageUuid, refusedReadRequest } from './exception-triage.validation.ts'

// A8.2 §5 — exactly three routes on one exception intake of one Claim: POST one triage event (201) under
// exceptionIntake.read and exceptionTriage.record (Admin), and two read-only GETs — the ordered history and the derived
// disposition — under exceptionIntake.read and exceptionTriage.read (Admin, Viewer). Ownership resolves through the
// A6.7 path before any work; another tenant's Claim is answered exactly like a missing one (404), a member without a
// permission receives 403 and no session 401. No PUT, PATCH or DELETE, no collection or cross-Claim search, no
// client-selected current/latest, and no investigation, resolution, closure, SLA, escalation or export route.

export const exceptionTriageRouter = Router()

const statusFor = (code: TriageErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isTriageUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isTriageUuid(String(req.params.exceptionIntakeId))) {
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

exceptionTriageRouter.post(`${BASE}/triage-events`, requireIds, canReadIntake, requireMemberPermission(organizationIdFromClaim, 'exceptionTriage.record'), async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordTriageEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

exceptionTriageRouter.get(`${BASE}/triage-history`, requireIds, canReadIntake, requireMemberPermission(organizationIdFromClaim, 'exceptionTriage.read'), async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getTriageHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionTriageRouter.get(`${BASE}/triage-disposition`, requireIds, canReadIntake, requireMemberPermission(organizationIdFromClaim, 'exceptionTriage.read'), async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getTriageDisposition(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
