import { Router, type Request } from 'express'
import type { RuleDefinitionErrorCode } from './rule-definition.types.ts'
import { createRuleDefinition, getRuleDefinition, listRuleDefinitions, updateRuleDefinition } from './rule-definition.service.ts'
import { findRuleDefinitionById } from './rule-definition.repository.ts'
import { isRuleDefinitionUuid } from './rule-definition.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationRuleDefinitionRouter = Router()
export const ruleDefinitionRouter = Router()

const immutableFields = ['id', 'organizationId', 'ownershipScope', 'ruleKey', 'jurisdictionCode', 'createdAt', 'updatedAt']

function statusForRuleDefinitionError(code: RuleDefinitionErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function ruleDefinitionIdFromParams(req: Request): string {
  return String(req.params.id)
}

function hasImmutableFieldAttempt(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return immutableFields.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}

async function organizationIdFromExistingRuleDefinition(req: Request): Promise<string | null> {
  const id = ruleDefinitionIdFromParams(req)
  if (!isRuleDefinitionUuid(id)) return null
  const ruleDefinition = await findRuleDefinitionById(id)
  return ruleDefinition?.organizationId ?? null
}

organizationRuleDefinitionRouter.post(
  '/:organizationId/rule-definitions',
  requireOrganizationPermission(organizationIdFromRouteParam, 'rule_definition.create'),
  async (req, res) => {
    const result = await createRuleDefinition(
      organizationIdFromRouteParam(req),
      req.body?.ruleKey,
      req.body?.displayName,
      req.body?.jurisdictionCode,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleDefinitionError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationRuleDefinitionRouter.get(
  '/:organizationId/rule-definitions',
  requireOrganizationPermission(organizationIdFromRouteParam, 'rule_definition.read'),
  async (req, res) => {
    const result = await listRuleDefinitions(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleDefinitionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

ruleDefinitionRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingRuleDefinition, 'rule_definition.read'),
  async (req, res) => {
    const result = await getRuleDefinition(ruleDefinitionIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleDefinitionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

ruleDefinitionRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingRuleDefinition, 'rule_definition.update'),
  async (req, res) => {
    const result = await updateRuleDefinition(
      ruleDefinitionIdFromParams(req),
      req.body?.displayName,
      hasImmutableFieldAttempt(req.body),
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleDefinitionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
