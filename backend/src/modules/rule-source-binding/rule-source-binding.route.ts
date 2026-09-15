import { Router, type Request } from 'express'
import type { RuleSourceBindingErrorCode } from './rule-source-binding.types.ts'
import {
  createRuleSourceBinding,
  evaluateExecutability,
  getRuleSourceBinding,
  listRuleSourceBindings,
} from './rule-source-binding.service.ts'
import { findRuleSourceBindingWithOrganization } from './rule-source-binding.repository.ts'
import { findRuleVersionWithOrganization } from '../rule-version/rule-version.repository.ts'
import { isRuleSourceBindingUuid } from './rule-source-binding.validation.ts'
import { applicabilityDimensionKeys, type ApplicabilityDimensionKey } from '../rule-applicability/rule-applicability.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const versionSourceBindingsRouter = Router()
export const ruleSourceBindingRouter = Router()

function statusForRuleSourceBindingError(code: RuleSourceBindingErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function ruleVersionIdFromParams(req: Request): string {
  return String(req.params.ruleVersionId)
}

function ruleSourceBindingIdFromParams(req: Request): string {
  return String(req.params.id)
}

function dimensionInputsFromBody(body: unknown): Record<ApplicabilityDimensionKey, unknown> {
  const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const result = {} as Record<ApplicabilityDimensionKey, unknown>
  for (const key of applicabilityDimensionKeys) result[key] = source[key]
  return result
}

async function organizationIdFromParentRuleVersion(req: Request): Promise<string | null> {
  const ruleVersionId = ruleVersionIdFromParams(req)
  if (!isRuleSourceBindingUuid(ruleVersionId)) return null
  const version = await findRuleVersionWithOrganization(ruleVersionId)
  return version?.rule.organizationId ?? null
}

async function organizationIdFromExistingBinding(req: Request): Promise<string | null> {
  const id = ruleSourceBindingIdFromParams(req)
  if (!isRuleSourceBindingUuid(id)) return null
  const binding = await findRuleSourceBindingWithOrganization(id)
  return binding?.ruleVersion.rule.organizationId ?? null
}

versionSourceBindingsRouter.post(
  '/:ruleVersionId/source-bindings',
  requireOrganizationPermission(organizationIdFromParentRuleVersion, 'rule_source_binding.create'),
  async (req, res) => {
    const result = await createRuleSourceBinding(
      ruleVersionIdFromParams(req),
      req.body?.sourceInterpretationId,
      req.body?.sourceRole,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceBindingError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

versionSourceBindingsRouter.get(
  '/:ruleVersionId/source-bindings',
  requireOrganizationPermission(organizationIdFromParentRuleVersion, 'rule_source_binding.read'),
  async (req, res) => {
    const result = await listRuleSourceBindings(ruleVersionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceBindingError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

versionSourceBindingsRouter.post(
  '/:ruleVersionId/executability/evaluate',
  requireOrganizationPermission(organizationIdFromParentRuleVersion, 'rule_executability.evaluate'),
  async (req, res) => {
    const result = await evaluateExecutability(
      ruleVersionIdFromParams(req),
      req.body?.businessDate,
      dimensionInputsFromBody(req.body),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceBindingError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

ruleSourceBindingRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingBinding, 'rule_source_binding.read'),
  async (req, res) => {
    const result = await getRuleSourceBinding(ruleSourceBindingIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceBindingError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
