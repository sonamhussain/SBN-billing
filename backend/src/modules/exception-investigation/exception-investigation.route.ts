import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getInvestigationHistory, getInvestigationSummary, recordInvestigationEvent } from './exception-investigation.service.ts'
import type { InvestigationErrorCode } from './exception-investigation.types.ts'
import { isInvestigationUuid, refusedReadRequest } from './exception-investigation.validation.ts'

// A8.3 §6 — exactly three routes on one exception intake of one Claim, under the A8.2 prefix: POST one investigation
// event (201) under exceptionIntake.read, exceptionTriage.read and exceptionInvestigation.record (Admin; the service
// then requires the current, eligible A8.2 assignee), and two read-only GETs — the ordered history and the derived
// summary — under exceptionIntake.read, exceptionTriage.read and exceptionInvestigation.read (Admin, Viewer). Ownership
// resolves through the A6.7 path before any work; another tenant's Claim is answered exactly like a missing one (404),
// a member without a permission receives 403 and no session 401. No PUT, PATCH or DELETE, no collection or cross-Claim
// search, no client-selected current/latest, and no assignment, resolution, closure, escalation or export route.

export const exceptionInvestigationRouter = Router()

const statusFor = (code: InvestigationErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isInvestigationUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isInvestigationUuid(String(req.params.exceptionIntakeId))) {
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

exceptionInvestigationRouter.post(`${BASE}/investigation-events`, requireIds, canReadIntake, canReadTriage, requireMemberPermission(organizationIdFromClaim, 'exceptionInvestigation.record'), async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordInvestigationEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

exceptionInvestigationRouter.get(`${BASE}/investigation-history`, requireIds, canReadIntake, canReadTriage, requireMemberPermission(organizationIdFromClaim, 'exceptionInvestigation.read'), async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getInvestigationHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionInvestigationRouter.get(`${BASE}/investigation-summary`, requireIds, canReadIntake, canReadTriage, requireMemberPermission(organizationIdFromClaim, 'exceptionInvestigation.read'), async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getInvestigationSummary(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
