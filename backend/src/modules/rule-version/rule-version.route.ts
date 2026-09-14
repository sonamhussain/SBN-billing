import { Router, type Request } from 'express'
import type { RuleVersionErrorCode } from './rule-version.types.ts'
import {
  createRuleVersion,
  getRuleVersion,
  listRuleVersions,
  updateRuleVersionMetadata,
  updateRuleVersionVerification,
} from './rule-version.service.ts'
import { findRuleVersionWithOrganization } from './rule-version.repository.ts'
import { findRuleDefinitionById } from '../rule-definition/rule-definition.repository.ts'
import { isRuleVersionUuid } from './rule-version.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const ruleVersionsForRuleRouter = Router()
export const ruleVersionRouter = Router()

const immutableFields = ['id', 'ruleId', 'version', 'verificationStatus', 'verifiedAt', 'createdAt', 'updatedAt']

function statusForRuleVersionError(code: RuleVersionErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function ruleIdFromParams(req: Request): string {
  return String(req.params.ruleId)
}

function ruleVersionIdFromParams(req: Request): string {
  return String(req.params.id)
}

function hasImmutableFieldAttempt(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return immutableFields.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}

async function organizationIdFromParentRule(req: Request): Promise<string | null> {
  const ruleId = ruleIdFromParams(req)
  if (!isRuleVersionUuid(ruleId)) return null
  const rule = await findRuleDefinitionById(ruleId)
  return rule?.organizationId ?? null
}

async function organizationIdFromExistingVersion(req: Request): Promise<string | null> {
  const id = ruleVersionIdFromParams(req)
  if (!isRuleVersionUuid(id)) return null
  const version = await findRuleVersionWithOrganization(id)
  return version?.rule.organizationId ?? null
}

ruleVersionsForRuleRouter.post(
  '/:ruleId/versions',
  requireOrganizationPermission(organizationIdFromParentRule, 'rule_version.create'),
  async (req, res) => {
    const result = await createRuleVersion(
      ruleIdFromParams(req),
      req.body?.version,
      req.body?.effectType,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleVersionError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

ruleVersionsForRuleRouter.get(
  '/:ruleId/versions',
  requireOrganizationPermission(organizationIdFromParentRule, 'rule_version.read'),
  async (req, res) => {
    const result = await listRuleVersions(ruleIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleVersionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

ruleVersionRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'rule_version.read'),
  async (req, res) => {
    const result = await getRuleVersion(ruleVersionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleVersionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

ruleVersionRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'rule_version.update'),
  async (req, res) => {
    const result = await updateRuleVersionMetadata(
      ruleVersionIdFromParams(req),
      req.body?.effectType,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      hasImmutableFieldAttempt(req.body),
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleVersionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

ruleVersionRouter.post(
  '/:id/verification',
  requireOrganizationPermission(organizationIdFromExistingVersion, 'rule_version.verify'),
  async (req, res) => {
    const result = await updateRuleVersionVerification(
      ruleVersionIdFromParams(req),
      req.body?.verificationStatus,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleVersionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
