import { Router, type Request } from 'express'
import type { EvidenceArtifactErrorCode } from './evidence-artifact.types.ts'
import {
  appendEvidenceVersion,
  createEvidenceArtifact,
  getEvidenceArtifact,
  getEvidenceVersion,
  listEvidenceArtifacts,
  listEvidenceVersions,
} from './evidence-artifact.service.ts'
import { findEvidenceArtifactOwnership, findEvidenceVersionOwnership } from './evidence-artifact.repository.ts'
import { isEvidenceUuid } from './evidence-artifact.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.1 — six routes, all of them GET or POST.
//
// There is no PATCH and no DELETE on either model, and there never will be: a version is
// append-only, so a correction is a new version rather than an edit, and an artifact that could be
// deleted would take a decision's evidence with it. There is also no upload, download or content
// endpoint — A5.1 stores metadata about evidence held elsewhere and never transports the evidence
// itself, so there is nothing here that could return bytes or a signed link.

export const organizationEvidenceArtifactRouter = Router()
export const evidenceArtifactRouter = Router()
export const evidenceArtifactVersionRouter = Router()

function statusForError(code: EvidenceArtifactErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INTERNAL_ERROR') return 500
  return 400
}

const organizationIdFromRoute = (req: Request) => String(req.params.organizationId)

// Ownership for a by-id request is resolved from the artifact itself, server-side, before
// authorization runs. A version resolves ownership through its parent, which is why no
// organizationId is copied onto version rows.
async function organizationIdFromArtifact(req: Request): Promise<string | null> {
  const id = String(req.params.artifactId)
  if (!isEvidenceUuid(id)) return null
  return (await findEvidenceArtifactOwnership(id))?.organizationId ?? null
}

async function organizationIdFromVersion(req: Request): Promise<string | null> {
  const id = String(req.params.versionId)
  if (!isEvidenceUuid(id)) return null
  return (await findEvidenceVersionOwnership(id))?.evidenceArtifact.organizationId ?? null
}

organizationEvidenceArtifactRouter.post(
  '/:organizationId/evidence-artifacts',
  requireOrganizationPermission(organizationIdFromRoute, 'evidenceArtifact.create'),
  async (req, res) => {
    // The organization comes from the authenticated path, never from the body: a client-supplied
    // organizationId is rejected by validation as a server-owned field.
    const result = await createEvidenceArtifact(organizationIdFromRoute(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationEvidenceArtifactRouter.get(
  '/:organizationId/evidence-artifacts',
  requireOrganizationPermission(organizationIdFromRoute, 'evidenceArtifact.read'),
  async (req, res) => {
    const result = await listEvidenceArtifacts(organizationIdFromRoute(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

evidenceArtifactRouter.get(
  '/:artifactId',
  requireOrganizationPermission(organizationIdFromArtifact, 'evidenceArtifact.read'),
  async (req, res) => {
    const result = await getEvidenceArtifact(String(req.params.artifactId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

evidenceArtifactRouter.get(
  '/:artifactId/versions',
  requireOrganizationPermission(organizationIdFromArtifact, 'evidenceArtifact.read'),
  async (req, res) => {
    const result = await listEvidenceVersions(String(req.params.artifactId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

evidenceArtifactRouter.post(
  '/:artifactId/versions',
  requireOrganizationPermission(organizationIdFromArtifact, 'evidenceArtifactVersion.create'),
  async (req, res) => {
    const result = await appendEvidenceVersion(String(req.params.artifactId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

evidenceArtifactVersionRouter.get(
  '/:versionId',
  requireOrganizationPermission(organizationIdFromVersion, 'evidenceArtifact.read'),
  async (req, res) => {
    const result = await getEvidenceVersion(String(req.params.versionId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
