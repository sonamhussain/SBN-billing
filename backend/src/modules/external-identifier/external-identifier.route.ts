import { Router, type Request } from 'express'
import type { ExternalIdentifierErrorCode } from './external-identifier.types.ts'
import {
  createExternalIdentifier,
  getExternalIdentifier,
  listExternalIdentifiers,
  updateExternalIdentifier,
} from './external-identifier.service.ts'
import { findExternalIdentifierById } from './external-identifier.repository.ts'
import { isExternalIdentifierUuid } from './external-identifier.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationExternalIdentifierRouter = Router()
export const externalIdentifierRouter = Router()

function statusForExternalIdentifierError(code: ExternalIdentifierErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function externalIdentifierIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingExternalIdentifier(req: Request): Promise<string | null> {
  const id = externalIdentifierIdFromParams(req)
  if (!isExternalIdentifierUuid(id)) return null
  const externalIdentifier = await findExternalIdentifierById(id)
  return externalIdentifier?.organizationId ?? null
}

organizationExternalIdentifierRouter.post(
  '/:organizationId/external-identifiers',
  requireOrganizationPermission(organizationIdFromRouteParam, 'external_identifier.create'),
  async (req, res) => {
    const result = await createExternalIdentifier(
      organizationIdFromRouteParam(req),
      req.body?.sourceSystem,
      req.body?.externalValue,
      req.body?.target,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForExternalIdentifierError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationExternalIdentifierRouter.get(
  '/:organizationId/external-identifiers',
  requireOrganizationPermission(organizationIdFromRouteParam, 'external_identifier.read'),
  async (req, res) => {
    const result = await listExternalIdentifiers(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForExternalIdentifierError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

externalIdentifierRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingExternalIdentifier, 'external_identifier.read'),
  async (req, res) => {
    const result = await getExternalIdentifier(externalIdentifierIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForExternalIdentifierError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

externalIdentifierRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingExternalIdentifier, 'external_identifier.update'),
  async (req, res) => {
    const result = await updateExternalIdentifier(
      externalIdentifierIdFromParams(req),
      req.body?.sourceSystem,
      req.body?.externalValue,
      req.body?.target,
      req.body?.targetType,
      req.body?.targetId,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForExternalIdentifierError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
