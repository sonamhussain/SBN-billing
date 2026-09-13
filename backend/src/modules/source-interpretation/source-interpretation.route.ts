import { Router, type Request } from 'express'
import type { SourceInterpretationErrorCode } from './source-interpretation.types.ts'
import {
  createSourceInterpretation,
  getSourceInterpretation,
  listSourceInterpretations,
  updateSourceInterpretation,
} from './source-interpretation.service.ts'
import { findSourceInterpretationWithOrganization } from './source-interpretation.repository.ts'
import { findRuleSourceVersionWithOrganization } from '../rule-source-version/rule-source-version.repository.ts'
import { isSourceInterpretationUuid } from './source-interpretation.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const versionInterpretationsRouter = Router()
export const sourceInterpretationRouter = Router()

const immutableFields = ['id', 'sourceVersionId', 'verifiedAt', 'createdAt', 'updatedAt']

function statusForSourceInterpretationError(code: SourceInterpretationErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function sourceVersionIdFromParams(req: Request): string {
  return String(req.params.sourceVersionId)
}

function sourceInterpretationIdFromParams(req: Request): string {
  return String(req.params.id)
}

function hasImmutableFieldAttempt(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return immutableFields.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}

async function organizationIdFromParentVersion(req: Request): Promise<string | null> {
  const sourceVersionId = sourceVersionIdFromParams(req)
  if (!isSourceInterpretationUuid(sourceVersionId)) return null
  const version = await findRuleSourceVersionWithOrganization(sourceVersionId)
  return version?.source.organizationId ?? null
}

async function organizationIdFromExistingInterpretation(req: Request): Promise<string | null> {
  const id = sourceInterpretationIdFromParams(req)
  if (!isSourceInterpretationUuid(id)) return null
  const interpretation = await findSourceInterpretationWithOrganization(id)
  return interpretation?.sourceVersion.source.organizationId ?? null
}

versionInterpretationsRouter.post(
  '/:sourceVersionId/interpretations',
  requireOrganizationPermission(organizationIdFromParentVersion, 'source_interpretation.create'),
  async (req, res) => {
    const result = await createSourceInterpretation(
      sourceVersionIdFromParams(req),
      req.body?.interpretationVersion,
      req.body?.normalizedInterpretationRef,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForSourceInterpretationError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

versionInterpretationsRouter.get(
  '/:sourceVersionId/interpretations',
  requireOrganizationPermission(organizationIdFromParentVersion, 'source_interpretation.read'),
  async (req, res) => {
    const result = await listSourceInterpretations(sourceVersionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForSourceInterpretationError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

sourceInterpretationRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingInterpretation, 'source_interpretation.read'),
  async (req, res) => {
    const result = await getSourceInterpretation(sourceInterpretationIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForSourceInterpretationError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

sourceInterpretationRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingInterpretation, 'source_interpretation.update'),
  async (req, res) => {
    const result = await updateSourceInterpretation(
      sourceInterpretationIdFromParams(req),
      req.body?.normalizedInterpretationRef,
      req.body?.verificationStatus,
      hasImmutableFieldAttempt(req.body),
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForSourceInterpretationError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
