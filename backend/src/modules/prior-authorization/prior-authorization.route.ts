import { Router, type Request } from 'express'
import type { PriorAuthorizationErrorCode } from './prior-authorization.types.ts'
import {
  appendPriorAuthorizationVersion,
  createPriorAuthorization,
  getPriorAuthorization,
  getPriorAuthorizationVersion,
  listPriorAuthorizations,
  listPriorAuthorizationVersions,
} from './prior-authorization.service.ts'
import { findAuthorizationOwnership, findEncounterOwnership, findVersionOwnership } from './prior-authorization.repository.ts'
import { isAuthorizationUuid } from './prior-authorization.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.3 — six routes, all of them GET or POST.
//
// There is no PATCH and no DELETE on the case, its versions or their evidence links: a correction is
// a new version, and an authorization case that could be edited would take a decision's history with
// it. There is also deliberately no request or submit endpoint — A5.3 records what an authorization
// source reported rather than performing an authorization, and real payer transport belongs to A9.
//
// Ownership is resolved server-side before authorization runs, through the Encounter's Patient, and
// the projections used for it read no member identifier, policy identifier or evidence metadata.

export const encounterPriorAuthorizationRouter = Router()
export const priorAuthorizationRouter = Router()
export const priorAuthorizationVersionRouter = Router()

function statusForError(code: PriorAuthorizationErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INTERNAL_ERROR') return 500
  return 400
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = String(req.params.encounterId)
  if (!isAuthorizationUuid(id)) return null
  return (await findEncounterOwnership(id))?.patient.organizationId ?? null
}

async function organizationIdFromAuthorization(req: Request): Promise<string | null> {
  const id = String(req.params.authorizationId)
  if (!isAuthorizationUuid(id)) return null
  return (await findAuthorizationOwnership(id))?.encounter.patient.organizationId ?? null
}

async function organizationIdFromVersion(req: Request): Promise<string | null> {
  const id = String(req.params.versionId)
  if (!isAuthorizationUuid(id)) return null
  return (await findVersionOwnership(id))?.priorAuthorization.encounter.patient.organizationId ?? null
}

encounterPriorAuthorizationRouter.post(
  '/:encounterId/prior-authorizations',
  requireOrganizationPermission(organizationIdFromEncounter, 'priorAuthorization.create'),
  async (req, res) => {
    // The owning organization is not passed in: the service reads it from the Encounter under the
    // same lock it takes the context snapshot from, so a caller can never bind another tenant's
    // evidence or eligibility to their own authorization.
    const result = await createPriorAuthorization(String(req.params.encounterId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

encounterPriorAuthorizationRouter.get(
  '/:encounterId/prior-authorizations',
  requireOrganizationPermission(organizationIdFromEncounter, 'priorAuthorization.read'),
  async (req, res) => {
    const result = await listPriorAuthorizations(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

priorAuthorizationRouter.get(
  '/:authorizationId',
  requireOrganizationPermission(organizationIdFromAuthorization, 'priorAuthorization.read'),
  async (req, res) => {
    const result = await getPriorAuthorization(String(req.params.authorizationId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

priorAuthorizationRouter.get(
  '/:authorizationId/versions',
  requireOrganizationPermission(organizationIdFromAuthorization, 'priorAuthorization.read'),
  async (req, res) => {
    const result = await listPriorAuthorizationVersions(String(req.params.authorizationId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

priorAuthorizationRouter.post(
  '/:authorizationId/versions',
  requireOrganizationPermission(organizationIdFromAuthorization, 'priorAuthorizationVersion.create'),
  async (req, res) => {
    const result = await appendPriorAuthorizationVersion(String(req.params.authorizationId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

priorAuthorizationVersionRouter.get(
  '/:versionId',
  requireOrganizationPermission(organizationIdFromVersion, 'priorAuthorization.read'),
  async (req, res) => {
    const result = await getPriorAuthorizationVersion(String(req.params.versionId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
