import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A6.7 ownership path of a frozen submission (the organization that owns its Claim's encounter's patient).
import { findFreezeOwnership } from '../claim-submission/claim-submission.repository.ts'
import { findCaseOwnership } from './evidence-case.repository.ts'
import { assembleRevenueEvidenceCase, getRevenueEvidenceCase, listRevenueEvidenceCases } from './evidence-case.service.ts'
import type { CaseErrorCode, CaseResult } from './evidence-case.types.ts'
import { isCaseUuid } from './evidence-case.validation.ts'

// A7.4 §6 — one POST that records the server-assembled case snapshot of a frozen submission (201 new, 200 exact
// replay), the submission's case history and one case read. Ownership resolves through the A6.7 path before any
// work; another tenant's submission or case is answered exactly like a missing one (404), a member without the
// permission receives 403 and no session 401. No DELETE, PATCH or PUT, and no adjudication, payment, settlement,
// balance, remittance, send or payer-response route.

export const submissionCaseRouter = Router()
export const caseRouter = Router()

const statusFor = (code: CaseErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: CaseResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup; no query string is ever read.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isCaseUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromSubmission(req: Request): Promise<string | null> {
  return (await findFreezeOwnership(String(req.params.submissionId).toLowerCase()))?.organizationId ?? null
}

async function organizationIdFromCase(req: Request): Promise<string | null> {
  return (await findCaseOwnership(String(req.params.caseId).toLowerCase()))?.organizationId ?? null
}

submissionCaseRouter.post(
  '/:submissionId/revenue-evidence-cases',
  requireUuidParam('submissionId', 'claim submission'),
  requireMemberPermission(organizationIdFromSubmission, 'evidenceCase.create'),
  async (req, res) => {
    const result = await assembleRevenueEvidenceCase(String(req.params.submissionId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      send(res, result, 201)
      return
    }
    // The same stored case either way: 201 when new, 200 for the exact replay.
    res.status(result.value.replayed ? 200 : 201).json(result.value.case)
  },
)

submissionCaseRouter.get(
  '/:submissionId/revenue-evidence-cases',
  requireUuidParam('submissionId', 'claim submission'),
  requireMemberPermission(organizationIdFromSubmission, 'evidenceCase.read'),
  async (req, res) => {
    send(res, await listRevenueEvidenceCases(String(req.params.submissionId)), 200)
  },
)

caseRouter.get(
  '/:caseId',
  requireUuidParam('caseId', 'revenue evidence case'),
  requireMemberPermission(organizationIdFromCase, 'evidenceCase.read'),
  async (req, res) => {
    send(res, await getRevenueEvidenceCase(String(req.params.caseId)), 200)
  },
)
