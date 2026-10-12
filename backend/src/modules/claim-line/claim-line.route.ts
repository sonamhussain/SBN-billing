import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findClaimOwnership } from '../claim/claim.repository.ts'
import { findClaimLineOwnership } from './claim-line.repository.ts'
import { createClaimLine, listClaimLines, removeClaimLine, reorderClaimLines, setClaimLineDiagnosisPointers } from './claim-line.service.ts'
import type { ClaimStructureErrorCode, ClaimStructureResult } from './claim-line.types.ts'
import { isClaimStructureUuid } from './claim-line.validation.ts'

// A6.2 §12 — ClaimLine routes. Ownership resolves through Claim -> Encounter -> Patient -> Organization
// before any work, so another tenant's Claim or line is denied without disclosing a source, position or
// pointer. Path UUIDs and JSON bodies only; no source id ever travels in a query string. There is no
// DELETE, price, approve, submit or transmit route.

export const claimLinesRouter = Router()
export const claimLineRouter = Router()

export const claimStructureStatus = (code: ClaimStructureErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

export function sendClaimStructureResult<T>(res: Response, result: ClaimStructureResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, claimStructureStatus(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
export const requireStructureUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimStructureUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

export async function organizationIdFromClaim(req: Request): Promise<string | null> {
  return (await findClaimOwnership(String(req.params.claimId)))?.encounter.patient.organizationId ?? null
}

async function organizationIdFromLine(req: Request): Promise<string | null> {
  return (await findClaimLineOwnership(String(req.params.lineId)))?.organizationId ?? null
}

claimLinesRouter.post('/:claimId/lines', requireStructureUuidParam('claimId', 'claim'), requireOrganizationPermission(organizationIdFromClaim, 'claimLine.create'), async (req, res) => {
  sendClaimStructureResult(res, await createClaimLine(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 201)
})

claimLinesRouter.get('/:claimId/lines', requireStructureUuidParam('claimId', 'claim'), requireOrganizationPermission(organizationIdFromClaim, 'claimLine.read'), async (req, res) => {
  sendClaimStructureResult(res, await listClaimLines(String(req.params.claimId)), 200)
})

claimLinesRouter.put('/:claimId/lines/order', requireStructureUuidParam('claimId', 'claim'), requireOrganizationPermission(organizationIdFromClaim, 'claimLine.update'), async (req, res) => {
  sendClaimStructureResult(res, await reorderClaimLines(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 200)
})

claimLineRouter.post('/:lineId/remove', requireStructureUuidParam('lineId', 'claim line'), requireOrganizationPermission(organizationIdFromLine, 'claimLine.update'), async (req, res) => {
  sendClaimStructureResult(res, await removeClaimLine(String(req.params.lineId), req.body, String(res.locals.actorUserId)), 200)
})

claimLineRouter.put(
  '/:lineId/diagnosis-pointers',
  requireStructureUuidParam('lineId', 'claim line'),
  requireOrganizationPermission(organizationIdFromLine, 'claimLine.update'),
  async (req, res) => {
    sendClaimStructureResult(res, await setClaimLineDiagnosisPointers(String(req.params.lineId), req.body, String(res.locals.actorUserId)), 200)
  },
)
