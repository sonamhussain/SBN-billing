import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { organizationIdFromClaim } from '../claim-line/claim-line.route.ts'
import { previewCanonicalClaimPayload } from './claim-payload.composer.ts'
import type { ClaimPayloadErrorCode } from './claim-payload.types.ts'
import { isClaimPayloadUuid } from './claim-payload.validation.ts'

// A6.6 §8 — one read-only preview of the canonical payload of an exact Claim, draft assessment and approval.
// POST only because the request carries the two exact ids; it creates, updates and deletes nothing.
// Ownership resolves through Claim -> Encounter -> Patient -> Organization before any work; another
// tenant's Claim is answered exactly like a missing one (404), and a member without claimCanonical.read
// receives 403. There is no create, update, delete, submit, send or payload-persistence route.

export const claimPayloadRouter = Router()

const statusFor = (code: ClaimPayloadErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

// A malformed id is a safe 400 before any lookup.
const requireClaimIdParam = (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimPayloadUuid(String(req.params.claimId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid claim id')
    return
  }
  next()
}

claimPayloadRouter.post('/:claimId/canonical-payload/preview', requireClaimIdParam, requireMemberPermission(organizationIdFromClaim, 'claimCanonical.read'), async (req, res) => {
  const result = await previewCanonicalClaimPayload(String(req.params.claimId), req.body)
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
