import { Router, type Request } from 'express'
import type { AuthorizationLineErrorCode } from './authorization-line.types.ts'
import { captureAuthorizationLines, evaluateAuthorizationScope, getAuthorizationLine, listAuthorizationLines } from './authorization-line.service.ts'
import { findLineOwnership, findVersionOwnership } from './authorization-line.repository.ts'
import { isAuthorizationLineUuid } from './authorization-line.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.4 — four routes, all of them GET or POST.
//
// There is no PATCH and no DELETE on a line, no single-line append after capture and no claim-line
// endpoint. A line set is captured once for one exact A5.3 version; a correction is a new version.
//
// Ownership is resolved server-side before authorization runs, through
// PriorAuthorizationVersion -> PriorAuthorization -> Encounter -> Patient, with projections that read
// no member identifier, policy identifier, authorization reference or evidence metadata.

export const versionAuthorizationLineRouter = Router()
export const authorizationLineRouter = Router()

function statusForError(code: AuthorizationLineErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INTERNAL_ERROR') return 500
  return 400
}

async function organizationIdFromVersion(req: Request): Promise<string | null> {
  const id = String(req.params.versionId)
  if (!isAuthorizationLineUuid(id)) return null
  return (await findVersionOwnership(id))?.priorAuthorization.encounter.patient.organizationId ?? null
}

async function organizationIdFromLine(req: Request): Promise<string | null> {
  const id = String(req.params.lineId)
  if (!isAuthorizationLineUuid(id)) return null
  return (await findLineOwnership(id))?.priorAuthorizationVersion.priorAuthorization.encounter.patient.organizationId ?? null
}

versionAuthorizationLineRouter.post(
  '/:versionId/authorization-lines',
  requireOrganizationPermission(organizationIdFromVersion, 'authorizationLine.create'),
  async (req, res) => {
    // The owning organization is not passed in: the service reads it again under the version's row
    // lock, and checks every master against it there.
    const result = await captureAuthorizationLines(String(req.params.versionId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

versionAuthorizationLineRouter.get(
  '/:versionId/authorization-lines',
  requireOrganizationPermission(organizationIdFromVersion, 'authorizationLine.read'),
  async (req, res) => {
    const result = await listAuthorizationLines(String(req.params.versionId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

// Read-only: nothing is persisted and no audit event is written, however often it is called.
versionAuthorizationLineRouter.get(
  '/:versionId/scope-evaluation',
  requireOrganizationPermission(organizationIdFromVersion, 'authorizationLine.evaluate'),
  async (req, res) => {
    const result = await evaluateAuthorizationScope(String(req.params.versionId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

authorizationLineRouter.get(
  '/:lineId',
  requireOrganizationPermission(organizationIdFromLine, 'authorizationLine.read'),
  async (req, res) => {
    const result = await getAuthorizationLine(String(req.params.lineId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
