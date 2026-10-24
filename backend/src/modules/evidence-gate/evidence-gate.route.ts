import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
// The A7.2 ownership path of a classification (stored organization, held equal to its source's).
import { findClassificationOwnership } from '../evidence-classification/evidence-classification.repository.ts'
import { findReadinessOwnership } from './evidence-gate.repository.ts'
import { getAdjudicationReadiness, listAdjudicationReadiness, recordAdjudicationReadiness } from './evidence-gate.service.ts'
import type { ReadinessErrorCode, ReadinessResult } from './evidence-gate.types.ts'
import { isReadinessUuid } from './evidence-gate.validation.ts'

// A7.3 §6 — one POST that records the server-derived internal readiness of an A7.2 classification (201 new, 200
// exact replay), the classification's readiness history and one readiness read. Ownership resolves through the A7.2
// path before any work; another tenant's classification or result is answered exactly like a missing one (404), a
// member without the permission receives 403 and no session 401. No DELETE, PATCH or PUT, and no adjudication,
// payment, denial, remittance, verify, send or payer-response route.

export const classificationReadinessRouter = Router()
export const readinessRouter = Router()

const statusFor = (code: ReadinessErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function send<T>(res: Response, result: ReadinessResult<T>, successStatus: number) {
  if (!result.ok) {
    sendApiError(res, statusFor(result.code), result.code, result.message)
    return
  }
  res.status(successStatus).json(result.value)
}

// A malformed id is a safe 400 before any lookup; no query string is ever read.
const requireUuidParam = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!isReadinessUuid(String(req.params[param]))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', `invalid ${label} id`)
    return
  }
  next()
}

async function organizationIdFromClassification(req: Request): Promise<string | null> {
  return (await findClassificationOwnership(String(req.params.classificationId).toLowerCase()))?.organizationId ?? null
}

async function organizationIdFromReadiness(req: Request): Promise<string | null> {
  return (await findReadinessOwnership(String(req.params.readinessId).toLowerCase()))?.organizationId ?? null
}

classificationReadinessRouter.post(
  '/:classificationId/adjudication-readiness',
  requireUuidParam('classificationId', 'revenue evidence classification'),
  requireMemberPermission(organizationIdFromClassification, 'adjudicationReadiness.create'),
  async (req, res) => {
    const result = await recordAdjudicationReadiness(String(req.params.classificationId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      send(res, result, 201)
      return
    }
    // The same stored result either way: 201 when new, 200 for the exact replay.
    res.status(result.value.replayed ? 200 : 201).json(result.value.readiness)
  },
)

classificationReadinessRouter.get(
  '/:classificationId/adjudication-readiness',
  requireUuidParam('classificationId', 'revenue evidence classification'),
  requireMemberPermission(organizationIdFromClassification, 'adjudicationReadiness.read'),
  async (req, res) => {
    send(res, await listAdjudicationReadiness(String(req.params.classificationId)), 200)
  },
)

readinessRouter.get(
  '/:readinessId',
  requireUuidParam('readinessId', 'adjudication evidence readiness'),
  requireMemberPermission(organizationIdFromReadiness, 'adjudicationReadiness.read'),
  async (req, res) => {
    send(res, await getAdjudicationReadiness(String(req.params.readinessId)), 200)
  },
)
