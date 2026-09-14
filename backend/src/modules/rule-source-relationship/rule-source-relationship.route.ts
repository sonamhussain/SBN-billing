import { Router, type Request } from 'express'
import type { RuleSourceRelationshipErrorCode } from './rule-source-relationship.types.ts'
import { createRelationship, getRelationship, listRelationshipsForVersion } from './rule-source-relationship.service.ts'
import { findRelationshipWithParents } from './rule-source-relationship.repository.ts'
import { findRuleSourceVersionWithOrganization } from '../rule-source-version/rule-source-version.repository.ts'
import { isRuleSourceRelationshipUuid } from './rule-source-relationship.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const versionRelationshipsRouter = Router()
export const ruleSourceRelationshipRouter = Router()

function statusForRelationshipError(code: RuleSourceRelationshipErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function fromVersionIdFromParams(req: Request): string {
  return String(req.params.fromVersionId)
}

function versionIdFromParams(req: Request): string {
  return String(req.params.versionId)
}

function relationshipIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromVersionParam(req: Request, paramName: 'fromVersionId' | 'versionId'): Promise<string | null> {
  const id = String(req.params[paramName])
  if (!isRuleSourceRelationshipUuid(id)) return null
  const version = await findRuleSourceVersionWithOrganization(id)
  return version?.source.organizationId ?? null
}

async function organizationIdFromExistingRelationship(req: Request): Promise<string | null> {
  const id = relationshipIdFromParams(req)
  if (!isRuleSourceRelationshipUuid(id)) return null
  const relationship = await findRelationshipWithParents(id)
  if (!relationship) return null
  return relationship.fromSourceVersion.source.organizationId ?? relationship.toSourceVersion.source.organizationId ?? null
}

versionRelationshipsRouter.post(
  '/:fromVersionId/relationships',
  requireOrganizationPermission((req) => organizationIdFromVersionParam(req, 'fromVersionId'), 'rule_source_relationship.create'),
  async (req, res) => {
    const result = await createRelationship(
      fromVersionIdFromParams(req),
      req.body?.toSourceVersionId,
      req.body?.relationshipType,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRelationshipError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

versionRelationshipsRouter.get(
  '/:versionId/relationships',
  requireOrganizationPermission((req) => organizationIdFromVersionParam(req, 'versionId'), 'rule_source_relationship.read'),
  async (req, res) => {
    const result = await listRelationshipsForVersion(versionIdFromParams(req), req.query?.direction)
    if (!result.ok) {
      sendApiError(res, statusForRelationshipError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

ruleSourceRelationshipRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingRelationship, 'rule_source_relationship.read'),
  async (req, res) => {
    const result = await getRelationship(relationshipIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRelationshipError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
