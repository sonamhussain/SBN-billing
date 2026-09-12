import { Router, type Request } from 'express'
import type { RuleSourceVersionErrorCode } from './rule-source-version.types.ts'
import { createRuleSourceVersion, getRuleSourceVersion, listRuleSourceVersions } from './rule-source-version.service.ts'
import { findRuleSourceVersionWithOrganization } from './rule-source-version.repository.ts'
import { findRuleSourceById } from '../rule-source/rule-source.repository.ts'
import { isRuleSourceVersionUuid } from './rule-source-version.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const sourceVersionsRouter = Router()
export const ruleSourceVersionRouter = Router()

function statusForRuleSourceVersionError(code: RuleSourceVersionErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function sourceIdFromParams(req: Request): string {
  return String(req.params.sourceId)
}

function ruleSourceVersionIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromParentSource(req: Request): Promise<string | null> {
  const sourceId = sourceIdFromParams(req)
  if (!isRuleSourceVersionUuid(sourceId)) return null
  const source = await findRuleSourceById(sourceId)
  return source?.organizationId ?? null
}

async function organizationIdFromExistingVersion(req: Request): Promise<string | null> {
  const id = ruleSourceVersionIdFromParams(req)
  if (!isRuleSourceVersionUuid(id)) return null
  const version = await findRuleSourceVersionWithOrganization(id)
  return version?.source.organizationId ?? null
}

sourceVersionsRouter.post(
  '/:sourceId/versions',
  requireOrganizationPermission(organizationIdFromParentSource, 'rule_source_version.create'),
  async (req, res) => {
    const result = await createRuleSourceVersion(
      sourceIdFromParams(req),
      req.body?.version,
      req.body?.rawEvidenceRef,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceVersionError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

sourceVersionsRouter.get(
  '/:sourceId/versions',
  requireOrganizationPermission(organizationIdFromParentSource, 'rule_source_version.read'),
  async (req, res) => {
    const result = await listRuleSourceVersions(sourceIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceVersionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

ruleSourceVersionRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'rule_source_version.read'),
  async (req, res) => {
    const result = await getRuleSourceVersion(ruleSourceVersionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceVersionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
