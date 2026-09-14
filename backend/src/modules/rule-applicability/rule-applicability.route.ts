import { Router, type Request } from 'express'
import type { RuleApplicabilityErrorCode } from './rule-applicability.types.ts'
import { applicabilityDimensionKeys, isRuleApplicabilityUuid, type ApplicabilityDimensionKey } from './rule-applicability.validation.ts'
import {
  createRuleApplicability,
  evaluateRuleApplicability,
  getRuleApplicability,
  listRuleApplicabilities,
} from './rule-applicability.service.ts'
import { findRuleApplicabilityWithOrganization } from './rule-applicability.repository.ts'
import { findRuleVersionWithOrganization } from '../rule-version/rule-version.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const versionApplicabilitiesRouter = Router()
export const ruleApplicabilityRouter = Router()

function statusForRuleApplicabilityError(code: RuleApplicabilityErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function ruleVersionIdFromParams(req: Request): string {
  return String(req.params.ruleVersionId)
}

function ruleApplicabilityIdFromParams(req: Request): string {
  return String(req.params.id)
}

function dimensionInputsFromBody(body: unknown): Record<ApplicabilityDimensionKey, unknown> {
  const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const result = {} as Record<ApplicabilityDimensionKey, unknown>
  for (const key of applicabilityDimensionKeys) result[key] = source[key]
  return result
}

function hasUnknownFieldAttempt(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const allowed: readonly string[] = applicabilityDimensionKeys
  return Object.keys(body).some((key) => !allowed.includes(key))
}

async function organizationIdFromParentRuleVersion(req: Request): Promise<string | null> {
  const ruleVersionId = ruleVersionIdFromParams(req)
  if (!isRuleApplicabilityUuid(ruleVersionId)) return null
  const version = await findRuleVersionWithOrganization(ruleVersionId)
  return version?.rule.organizationId ?? null
}

async function organizationIdFromExistingApplicability(req: Request): Promise<string | null> {
  const id = ruleApplicabilityIdFromParams(req)
  if (!isRuleApplicabilityUuid(id)) return null
  const applicability = await findRuleApplicabilityWithOrganization(id)
  return applicability?.ruleVersion.rule.organizationId ?? null
}

versionApplicabilitiesRouter.post(
  '/:ruleVersionId/applicabilities',
  requireOrganizationPermission(organizationIdFromParentRuleVersion, 'rule_applicability.create'),
  async (req, res) => {
    const result = await createRuleApplicability(
      ruleVersionIdFromParams(req),
      dimensionInputsFromBody(req.body),
      hasUnknownFieldAttempt(req.body),
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleApplicabilityError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

versionApplicabilitiesRouter.get(
  '/:ruleVersionId/applicabilities',
  requireOrganizationPermission(organizationIdFromParentRuleVersion, 'rule_applicability.read'),
  async (req, res) => {
    const result = await listRuleApplicabilities(ruleVersionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleApplicabilityError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

versionApplicabilitiesRouter.post(
  '/:ruleVersionId/applicability/evaluate',
  requireOrganizationPermission(organizationIdFromParentRuleVersion, 'rule_applicability.read'),
  async (req, res) => {
    const result = await evaluateRuleApplicability(ruleVersionIdFromParams(req), dimensionInputsFromBody(req.body))
    if (!result.ok) {
      sendApiError(res, statusForRuleApplicabilityError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

ruleApplicabilityRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingApplicability, 'rule_applicability.read'),
  async (req, res) => {
    const result = await getRuleApplicability(ruleApplicabilityIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleApplicabilityError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
