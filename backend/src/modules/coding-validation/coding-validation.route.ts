import { Router, type NextFunction, type Request, type Response } from 'express'
import { prisma } from '../../shared/database/prisma.ts'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { refusedReadRequest } from '../coding-release/coding-release.validation.ts'
import { isClaimStructureUuid } from '../claim-line/claim-line.validation.ts'
import { getRunCodingReceipts, getSubmissionCodingProvenance } from './coding-validation.service.ts'
import type { CodingValidationErrorCode } from './coding-validation.types.ts'

// CRG-01 FINAL Checkpoint B — exactly two read-only routes, both verification as recorded (design freeze 1.2 §10):
//   GET /api/validation-runs/:runId/coding-receipts          (validationRun.read + codingRelease.read)
//   GET /api/claim-submissions/:submissionId/coding-provenance (claimFreeze.read + codingRelease.read)
// Ownership resolves to the organization before any work; another tenant's record is answered exactly like a missing
// one (404), a member without a permission receives 403 and no session 401. No query or body is accepted; nothing is
// written; there is no write, search or activation route.

export const codingValidationRouter = Router()

const statusFor = (code: CodingValidationErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

const requireUuid = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isClaimStructureUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationOfRun(req: Request): Promise<string | null> {
  const run = await prisma.validationRun.findUnique({ where: { id: String(req.params.runId).toLowerCase() }, select: { encounter: { select: { patient: { select: { organizationId: true } } } } } })
  return run?.encounter.patient.organizationId ?? null
}

async function organizationOfSubmission(req: Request): Promise<string | null> {
  const freeze = await prisma.claimFreeze.findUnique({
    where: { id: String(req.params.submissionId).toLowerCase() },
    select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
  return freeze?.claim.encounter.patient.organizationId ?? null
}

function refuseInput(req: Request, res: Response): boolean {
  const refused = refusedReadRequest(req.query, req.body)
  if (refused) sendApiError(res, 400, 'VALIDATION_ERROR', refused)
  return refused !== null
}

codingValidationRouter.get(
  '/validation-runs/:runId/coding-receipts',
  requireUuid('runId', 'validation run'),
  requireMemberPermission(organizationOfRun, 'validationRun.read'),
  requireMemberPermission(organizationOfRun, 'codingRelease.read'),
  async (req, res) => {
    if (refuseInput(req, res)) return
    const result = await getRunCodingReceipts(String(req.params.runId).toLowerCase())
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

codingValidationRouter.get(
  '/claim-submissions/:submissionId/coding-provenance',
  requireUuid('submissionId', 'claim submission'),
  requireMemberPermission(organizationOfSubmission, 'claimFreeze.read'),
  requireMemberPermission(organizationOfSubmission, 'codingRelease.read'),
  async (req, res) => {
    if (refuseInput(req, res)) return
    const result = await getSubmissionCodingProvenance(String(req.params.submissionId).toLowerCase())
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
