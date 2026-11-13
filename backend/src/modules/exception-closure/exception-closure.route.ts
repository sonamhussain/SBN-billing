import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getClosureHistory, getClosureReconstruction, recordClosureEvent } from './exception-closure.service.ts'
import { type ClosureErrorCode, CONFIRM_PERMISSION, PARENT_READ_PERMISSIONS, READER_PERMISSION } from './exception-closure.types.ts'
import { isClosureUuid, refusedReadRequest } from './exception-closure.validation.ts'

// A8.9 §6 — exactly three routes on one exception intake of one Claim, under the A8.2 prefix: POST one closure event
// (201) under all seven upstream read permissions — exceptionIntake.read, exceptionTriage.read,
// exceptionInvestigation.read, exceptionRemediation.read, exceptionRemediationWork.read, exceptionResolution.read and
// exceptionEscalation.read — and exceptionClosure.confirm (the service then requires an eligible, assigned exception and
// a confirmer independent of the A8.7 requester and decider); and two read-only GETs, the ordered history and the
// historical reconstruction, under the seven read permissions and exceptionClosure.read (Admin, Viewer). Ownership
// resolves through the A6.7 path before any work; another tenant's Claim is answered exactly like a missing one (404), a
// member without a permission receives 403 and no session 401. No PUT, PATCH or DELETE, no collection, list-all, search,
// bulk, job, current or sequence selector, and no reopen, automatic closure, SLA, payer, payment, claim correction,
// source mutation, export or transmission route.

export const exceptionClosureRouter = Router()

const statusFor = (code: ClosureErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireIds(req: Request, res: Response, next: NextFunction) {
  if (!isClosureUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  if (!isClosureUuid(String(req.params.exceptionIntakeId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid exception intake id')
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

const BASE = '/:claimId/exceptions/:exceptionIntakeId'
// The seven upstream read permissions, in owner order (A8.1, A8.2, A8.3, A8.5, A8.6, A8.7, A8.8).
const canReadParents = PARENT_READ_PERMISSIONS.map((permission) => requireMemberPermission(organizationIdFromClaim, permission))
const canConfirm = requireMemberPermission(organizationIdFromClaim, CONFIRM_PERMISSION)

exceptionClosureRouter.post(`${BASE}/closure-events`, requireIds, ...canReadParents, canConfirm, async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordClosureEvent(String(req.params.claimId), String(req.params.exceptionIntakeId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(201).json(result.value)
})

const canReadClosure = requireMemberPermission(organizationIdFromClaim, READER_PERMISSION)

exceptionClosureRouter.get(`${BASE}/closure-history`, requireIds, ...canReadParents, canReadClosure, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getClosureHistory(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

exceptionClosureRouter.get(`${BASE}/closure-reconstruction`, requireIds, ...canReadParents, canReadClosure, async (req, res) => {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await getClosureReconstruction(String(req.params.claimId), String(req.params.exceptionIntakeId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
