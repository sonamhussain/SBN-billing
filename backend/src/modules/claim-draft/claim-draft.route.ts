import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { organizationIdFromClaim } from '../claim-line/claim-line.route.ts'
import { findAssessmentOwnership } from './claim-draft.repository.ts'
import { createDraftAssessment, getDraftAssessment, listDraftAssessments, previewClaimDraft } from './claim-draft.service.ts'
import type { ClaimDraftErrorCode, ClaimDraftResult } from './claim-draft.types.ts'
import { isClaimDraftUuid } from './claim-draft.validation.ts'

// A6.4 §9 — one read-only draft preview, one POST that records an immutable assessment against an exact
// pricing run, and two history reads. Ownership resolves through Claim -> Encounter -> Patient ->
// Organization before any work; another tenant's Claim or assessment is answered exactly like a missing
// one (404). No PATCH, PUT or DELETE, and no approve, sign, submit or "current draft" route; a GET never
// assesses.

export const claimDraftRouter = Router()
export const draftAssessmentRouter = Router()

const statusFor = (code: ClaimDraftErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ClaimDraftResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimDraftUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromAssessment(req: Request): Promise<string | null> {
  return (await findAssessmentOwnership(String(req.params.assessmentId)))?.organizationId ?? null
}

// The preview is part of reading the Claim (claim.read, Admin and Viewer); it persists nothing.
claimDraftRouter.get('/:claimId/draft', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claim.read'), async (req, res) => {
  send(res, await previewClaimDraft(String(req.params.claimId), req.query), 200)
})

claimDraftRouter.post('/:claimId/draft-assessments', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimDraft.assess'), async (req, res) => {
  send(res, await createDraftAssessment(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 201)
})

claimDraftRouter.get('/:claimId/draft-assessments', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimDraft.read'), async (req, res) => {
  send(res, await listDraftAssessments(String(req.params.claimId)), 200)
})

draftAssessmentRouter.get('/:assessmentId', requireUuidParam('assessmentId', 'claim draft assessment'), requireMemberPermission(organizationIdFromAssessment, 'claimDraft.read'), async (req, res) => {
  send(res, await getDraftAssessment(String(req.params.assessmentId)), 200)
})
