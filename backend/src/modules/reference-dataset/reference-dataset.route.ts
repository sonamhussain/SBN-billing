import { Router, type NextFunction, type Request, type Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../../shared/auth/auth.ts'
import type { ReferenceDatasetErrorCode } from './reference-dataset.types.ts'
import {
  getReferenceDataset,
  getReferenceDatasetVersion,
  listReferenceDatasetVersions,
  listReferenceDatasets,
} from './reference-dataset.service.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const referenceDatasetRouter = Router()

function statusForError(code: ReferenceDatasetErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

// ReferenceDataset/ReferenceDatasetVersion are SYSTEM_SHARED (no organizationId) — reads are
// public to any signed-in user, gated on authentication only, never on organization membership.
async function requireAuthenticatedSession(req: Request, res: Response, next: NextFunction) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
  if (!session) {
    sendApiError(res, 401, 'UNAUTHENTICATED', 'sign in required')
    return
  }
  next()
}

referenceDatasetRouter.get('/', requireAuthenticatedSession, async (_req, res) => {
  const result = await listReferenceDatasets()
  if (!result.ok) {
    sendApiError(res, statusForError(result.code), result.code, result.message)
    return
  }
  res.status(200).json({ items: result.value })
})

referenceDatasetRouter.get('/:id', requireAuthenticatedSession, async (req, res) => {
  const result = await getReferenceDataset(String(req.params.id))
  if (!result.ok) {
    sendApiError(res, statusForError(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})

referenceDatasetRouter.get('/:id/versions', requireAuthenticatedSession, async (req, res) => {
  const result = await listReferenceDatasetVersions(String(req.params.id))
  if (!result.ok) {
    sendApiError(res, statusForError(result.code), result.code, result.message)
    return
  }
  res.status(200).json({ items: result.value })
})

export const referenceDatasetVersionRouter = Router()

referenceDatasetVersionRouter.get('/:id', requireAuthenticatedSession, async (req, res) => {
  const result = await getReferenceDatasetVersion(String(req.params.id))
  if (!result.ok) {
    sendApiError(res, statusForError(result.code), result.code, result.message)
    return
  }
  res.status(200).json(result.value)
})
