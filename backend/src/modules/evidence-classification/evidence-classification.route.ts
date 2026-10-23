import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A7.1 ownership path of a source record (stored organization, held equal to its frozen submission's).
import { findEvidenceOwnership } from '../revenue-evidence/revenue-evidence.repository.ts'
import { findClassificationOwnership } from './evidence-classification.repository.ts'
import { classifySourceEvidence, getClassification, listClassifications } from './evidence-classification.service.ts'
import type { EvidenceClassificationErrorCode, EvidenceClassificationResult } from './evidence-classification.types.ts'
import { isEvidenceClassificationUuid } from './evidence-classification.validation.ts'

// A7.2 §6 — one POST that records the server-derived classification of an A7.1 source record (201 new, 200
// exact replay), the source's classifications and one classification read. Ownership resolves through the A7.1
// path before any work; another tenant's source or classification is answered exactly like a missing one (404),
// a member without the permission receives 403 and no session 401. No DELETE, PATCH or PUT, and no payment,
// adjudication, denial, remittance, verify or payer-response route.

export const sourceClassificationRouter = Router()
export const classificationRouter = Router()

const statusFor = (code: EvidenceClassificationErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: EvidenceClassificationResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup; no query string is ever read.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isEvidenceClassificationUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromSource(req: Request): Promise<string | null> {
  return (await findEvidenceOwnership(String(req.params.evidenceId).toLowerCase()))?.organizationId ?? null
}

async function organizationIdFromClassification(req: Request): Promise<string | null> {
  return (await findClassificationOwnership(String(req.params.classificationId).toLowerCase()))?.organizationId ?? null
}

sourceClassificationRouter.post(
  '/:evidenceId/classifications',
  requireUuidParam('evidenceId', 'revenue source evidence'),
  requireMemberPermission(organizationIdFromSource, 'evidenceClassification.create'),
  async (req, res) => {
    const result = await classifySourceEvidence(String(req.params.evidenceId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      send(res, result, 201)
      return
    }
    // The same stored classification either way: 201 when new, 200 for the exact replay.
    res.status(result.value.replayed ? 200 : 201).json(result.value.classification)
  },
)

sourceClassificationRouter.get(
  '/:evidenceId/classifications',
  requireUuidParam('evidenceId', 'revenue source evidence'),
  requireMemberPermission(organizationIdFromSource, 'evidenceClassification.read'),
  async (req, res) => {
    send(res, await listClassifications(String(req.params.evidenceId)), 200)
  },
)

classificationRouter.get(
  '/:classificationId',
  requireUuidParam('classificationId', 'revenue evidence classification'),
  requireMemberPermission(organizationIdFromClassification, 'evidenceClassification.read'),
  async (req, res) => {
    send(res, await getClassification(String(req.params.classificationId)), 200)
  },
)
