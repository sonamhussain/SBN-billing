import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { organizationIdFromClaim } from '../claim-line/claim-line.route.ts'
import { findFreezeOwnership } from './claim-submission.repository.ts'
import { freezeClaimSubmission, getClaimSubmission, getEvidenceManifest, listClaimSubmissions } from './claim-submission.service.ts'
import type { ClaimSubmissionErrorCode, ClaimSubmissionResult } from './claim-submission.types.ts'
import { isClaimSubmissionUuid } from './claim-submission.validation.ts'

// A6.7 §6 — one POST that freezes an approved, current Claim (201 new, 200 exact idempotent replay), a
// history read, a metadata read and an Admin-only evidence manifest read. Ownership resolves through
// Claim -> Encounter -> Patient -> Organization before any work; another tenant's Claim or submission is
// answered exactly like a missing one (404), and a member without the permission receives 403. No raw
// bytes over HTTP; no PATCH, PUT or DELETE; no send, retry, status or acknowledgement route.

export const claimSubmissionRouter = Router()
export const frozenSubmissionRouter = Router()

const statusFor = (code: ClaimSubmissionErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ClaimSubmissionResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimSubmissionUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromSubmission(req: Request): Promise<string | null> {
  return (await findFreezeOwnership(String(req.params.submissionId).toLowerCase()))?.organizationId ?? null
}

claimSubmissionRouter.post('/:claimId/submissions', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimFreeze.create'), async (req, res) => {
  const result = await freezeClaimSubmission(String(req.params.claimId), req.body, String(res.locals.actorUserId))
  if (!result.ok) {
    send(res, result, 201)
    return
  }
  // The same frozen metadata either way: 201 for the new freeze, 200 for the exact replay.
  res.status(result.value.replayed ? 200 : 201).json(result.value.submission)
})

claimSubmissionRouter.get('/:claimId/submissions', requireUuidParam('claimId', 'claim'), requireMemberPermission(organizationIdFromClaim, 'claimFreeze.read'), async (req, res) => {
  send(res, await listClaimSubmissions(String(req.params.claimId)), 200)
})

frozenSubmissionRouter.get('/:submissionId', requireUuidParam('submissionId', 'claim submission'), requireMemberPermission(organizationIdFromSubmission, 'claimFreeze.read'), async (req, res) => {
  send(res, await getClaimSubmission(String(req.params.submissionId)), 200)
})

frozenSubmissionRouter.get(
  '/:submissionId/evidence-manifest',
  requireUuidParam('submissionId', 'claim submission'),
  requireMemberPermission(organizationIdFromSubmission, 'claimFreezeEvidence.read'),
  async (req, res) => {
    send(res, await getEvidenceManifest(String(req.params.submissionId)), 200)
  },
)
