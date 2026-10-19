import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { organizationIdFromClaim } from '../claim-line/claim-line.route.ts'
import { findLinkOwnership } from './claim-correction.repository.ts'
import { getCorrectionLink, listCorrectionLinks, recordCorrectionLink } from './claim-correction.service.ts'
import type { ClaimCorrectionErrorCode, ClaimCorrectionResult } from './claim-correction.types.ts'
import { isClaimCorrectionUuid } from './claim-correction.validation.ts'

// A6.9 §7 — one POST that records an immutable correction link (201 new, 200 exact replay), the Claim's
// ordered correction history and one link read. Ownership resolves through Claim -> Encounter -> Patient ->
// Organization before any work; another tenant's Claim or link is answered exactly like a missing one (404),
// a member without the permission receives 403 and no session 401. No DELETE, PATCH or PUT, and no submit,
// send, transport, acknowledgement or payer-response route; no bytes, digests or patient data are returned.

export const claimCorrectionRouter = Router()
export const correctionLinkRouter = Router()

const statusFor = (code: ClaimCorrectionErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ClaimCorrectionResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimCorrectionUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromLink(req: Request): Promise<string | null> {
  return (await findLinkOwnership(String(req.params.linkId).toLowerCase()))?.organizationId ?? null
}

claimCorrectionRouter.post('/:claimId/correction-links', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimCorrection.link'), async (req, res) => {
  const result = await recordCorrectionLink(String(req.params.claimId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    send(res, result, 201)
    return
  }
  // The same stored link either way: 201 for the new link, 200 for the exact replay.
  res.status(result.value.replayed ? 200 : 201).json(result.value.link)
})

claimCorrectionRouter.get('/:claimId/correction-links', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimCorrection.read'), async (req, res) => {
  send(res, await listCorrectionLinks(String(req.params.claimId)), 200)
})

correctionLinkRouter.get('/:linkId', requireUuidParam('linkId', 'claim correction link'), requireMemberPermission(organizationIdFromLink, 'claimCorrection.read'), async (req, res) => {
  send(res, await getCorrectionLink(String(req.params.linkId)), 200)
})
