import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a Claim (the organization that owns its encounter's patient).
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { listExceptionIntakes, recordExceptionIntake } from './exception-intake.service.ts'
import type { ExceptionIntakeErrorCode } from './exception-intake.types.ts'
import { isIntakeUuid, refusedListRequest } from './exception-intake.validation.ts'

// A8.1 §5/§6 — one POST that records an exception intake for one exact source of one Claim (201 new, 200 exact
// replay) under exceptionIntake.create (Admin), and one read of the Claim's intakes under exceptionIntake.read
// (Admin, Viewer). Ownership resolves through the A6.7 path before any work; another tenant's Claim is answered
// exactly like a missing one (404), a member without the permission receives 403 and no session 401. No /:id read, no
// PATCH, PUT or DELETE, and no assignment, status, resolution, closure, retry, escalation, transport or export route.

export const exceptionIntakeRouter = Router()

const statusFor = (code: ExceptionIntakeErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireClaimId(req: Request, res: Response, next: NextFunction) {
  if (!isIntakeUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  next()
}

async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimForFreeze(String(req.params.claimId).toLowerCase(), prisma))?.organizationId ?? null
}

exceptionIntakeRouter.post('/:claimId/exception-intake', requireClaimId, requireMemberPermission(organizationIdFromClaim, 'exceptionIntake.create'), async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `unsupported query parameter(s): ${Object.keys(req.query).join(', ')}`)
    return
  }
  const result = await recordExceptionIntake(String(req.params.claimId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  // The same stored intake either way: 201 when new, 200 for the exact replay.
  res.status(result.value.replayed ? 200 : 201).json(result.value.intake)
})

exceptionIntakeRouter.get('/:claimId/exception-intake', requireClaimId, requireMemberPermission(organizationIdFromClaim, 'exceptionIntake.read'), async (req, res) => {
  const refused = refusedListRequest(req.query, req.body)
  if (refused) {
    sendApiError(res, 400, 'VALIDATION_ERROR', refused)
    return
  }
  const result = await listExceptionIntakes(String(req.params.claimId))
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
