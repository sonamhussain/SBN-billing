import { Router, type NextFunction, type Request, type Response } from 'express'
import { requireMemberPermission } from '../../shared/authorization/require-member-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findEncounterOwnership } from '../validation-run/validation-run.repository.ts'
import { getCodingReleaseCheck } from './coding-release.service.ts'
import type { CodingReleaseErrorCode } from './coding-release.types.ts'
import { isCodingReleaseUuid, refusedReadRequest } from './coding-release.validation.ts'

// CRG-01 FINAL Checkpoint A — exactly one read-only route: the coding-release check of one encounter, under encounter.read and
// codingRelease.read (Admin, Viewer). Ownership resolves Encounter -> Patient -> Organization before any work; another
// tenant's encounter is answered exactly like a missing one (404), a member without a permission receives 403 and no
// session 401. There is no write, search, catalogue browse or activation route.

export const codingReleaseRouter = Router()

const statusFor = (code: CodingReleaseErrorCode) => (code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 409)

function requireEncounterUuid(req: Request, res: Response, next: NextFunction) {
  if (!isCodingReleaseUuid(String(req.params.encounterId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid encounter id')
    return
  }
  next()
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  return (await findEncounterOwnership(String(req.params.encounterId).toLowerCase()))?.patient.organizationId ?? null
}

codingReleaseRouter.get(
  '/:encounterId/coding-release-check',
  requireEncounterUuid,
  requireMemberPermission(organizationIdFromEncounter, 'encounter.read'),
  requireMemberPermission(organizationIdFromEncounter, 'codingRelease.read'),
  async (req, res) => {
    const refused = refusedReadRequest(req.query, req.body)
    if (refused) {
      sendApiError(res, 400, 'VALIDATION_ERROR', refused)
      return
    }
    const result = await getCodingReleaseCheck(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusFor(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
