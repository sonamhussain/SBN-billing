import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { organizationIdFromClaim } from '../claim-line/claim-line.route.ts'
import { isClaimStructureUuid } from '../claim-line/claim-line.validation.ts'
import { findPricingRunOwnership } from './claim-pricing.repository.ts'
import { createPricingRun, getPricingRun, listPricingRuns } from './claim-pricing.service.ts'
import type { ClaimPricingErrorCode, ClaimPricingResult } from './claim-pricing.types.ts'

// A6.3 §9 — pricing routes. Ownership resolves through Claim -> Encounter -> Patient -> Organization
// before any work; another tenant's Claim or run is answered exactly like a missing one (404), so no
// amount or existence is disclosed. Path UUIDs and an empty JSON body only. No PATCH, PUT, DELETE,
// approve, submit or "current price" route.

export const claimPricingRunsRouter = Router()
export const pricingRunRouter = Router()

const statusFor = (code: ClaimPricingErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ClaimPricingResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimStructureUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromPricingRun(req: Request): Promise<string | null> {
  return (await findPricingRunOwnership(String(req.params.pricingRunId)))?.organizationId ?? null
}

claimPricingRunsRouter.post('/:claimId/pricing-runs', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimPricing.create'), async (req, res) => {
  send(res, await createPricingRun(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 201)
})

claimPricingRunsRouter.get('/:claimId/pricing-runs', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimPricing.read'), async (req, res) => {
  send(res, await listPricingRuns(String(req.params.claimId)), 200)
})

pricingRunRouter.get('/:pricingRunId', requireUuidParam('pricingRunId', 'pricing run'), requireMemberPermission(organizationIdFromPricingRun, 'claimPricing.read'), async (req, res) => {
  send(res, await getPricingRun(String(req.params.pricingRunId)), 200)
})
