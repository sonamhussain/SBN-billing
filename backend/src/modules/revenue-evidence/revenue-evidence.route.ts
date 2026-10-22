import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a frozen submission (Submission -> Claim -> Encounter -> Patient ->
// Organization), reused unchanged.
import { findFreezeOwnership } from '../claim-submission/claim-submission.repository.ts'
import { findEvidenceOwnership } from './revenue-evidence.repository.ts'
import { getRevenueSourceEvidence, listRevenueSourceEvidence, registerRevenueSourceEvidence } from './revenue-evidence.service.ts'
import type { RevenueEvidenceErrorCode, RevenueEvidenceResult } from './revenue-evidence.types.ts'
import { isRevenueEvidenceUuid } from './revenue-evidence.validation.ts'

// A7.1 §5 — one POST that registers immutable revenue source evidence for a frozen submission (201 new, 200
// exact replay), the submission's registrations and one registration read. Ownership resolves through the A6.7
// path before any work; another tenant's submission or registration is answered exactly like a missing one
// (404), a member without the permission receives 403 and no session 401. No DELETE, PATCH or PUT, and no
// payment, posting, remittance, denial, adjudication, send or payer-response route.

export const submissionRevenueEvidenceRouter = Router()
export const revenueEvidenceRouter = Router()

const statusFor = (code: RevenueEvidenceErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: RevenueEvidenceResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isRevenueEvidenceUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromSubmission(req: Request): Promise<string | null> {
  return (await findFreezeOwnership(String(req.params.submissionId).toLowerCase()))?.organizationId ?? null
}

async function organizationIdFromEvidence(req: Request): Promise<string | null> {
  return (await findEvidenceOwnership(String(req.params.evidenceId).toLowerCase()))?.organizationId ?? null
}

submissionRevenueEvidenceRouter.post(
  '/:submissionId/revenue-source-evidence',
  requireUuidParam('submissionId', 'claim submission'),
  requireMemberPermission(organizationIdFromSubmission, 'revenueEvidence.create'),
  async (req, res) => {
    const result = await registerRevenueSourceEvidence(String(req.params.submissionId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      send(res, result, 201)
      return
    }
    // The same stored registration either way: 201 when new, 200 for the exact replay.
    res.status(result.value.replayed ? 200 : 201).json(result.value.evidence)
  },
)

submissionRevenueEvidenceRouter.get(
  '/:submissionId/revenue-source-evidence',
  requireUuidParam('submissionId', 'claim submission'),
  requireMemberPermission(organizationIdFromSubmission, 'revenueEvidence.read'),
  async (req, res) => {
    send(res, await listRevenueSourceEvidence(String(req.params.submissionId)), 200)
  },
)

revenueEvidenceRouter.get('/:evidenceId', requireUuidParam('evidenceId', 'revenue source evidence'), requireMemberPermission(organizationIdFromEvidence, 'revenueEvidence.read'), async (req, res) => {
  send(res, await getRevenueSourceEvidence(String(req.params.evidenceId)), 200)
})
