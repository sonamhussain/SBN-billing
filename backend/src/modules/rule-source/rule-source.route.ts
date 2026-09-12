import { Router, type Request } from 'express'
import type { RuleSourceErrorCode } from './rule-source.types.ts'
import { createRuleSource, getRuleSource, listRuleSources, updateRuleSource } from './rule-source.service.ts'
import { findRuleSourceById } from './rule-source.repository.ts'
import { isRuleSourceUuid } from './rule-source.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationRuleSourceRouter = Router()
export const ruleSourceRouter = Router()

const immutableFields = ['id', 'organizationId', 'ownershipScope', 'createdAt', 'updatedAt']

function statusForRuleSourceError(code: RuleSourceErrorCode) {
  return code === 'NOT_FOUND' ? 404 : 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function ruleSourceIdFromParams(req: Request): string {
  return String(req.params.id)
}

function hasImmutableFieldAttempt(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return immutableFields.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}

async function organizationIdFromExistingRuleSource(req: Request): Promise<string | null> {
  const id = ruleSourceIdFromParams(req)
  if (!isRuleSourceUuid(id)) return null
  const ruleSource = await findRuleSourceById(id)
  return ruleSource?.organizationId ?? null
}

organizationRuleSourceRouter.post(
  '/:organizationId/rule-sources',
  requireOrganizationPermission(organizationIdFromRouteParam, 'rule_source.create'),
  async (req, res) => {
    const result = await createRuleSource(
      organizationIdFromRouteParam(req),
      req.body?.jurisdictionCode,
      req.body?.issuingAuthority,
      req.body?.sourceCategory,
      req.body?.referenceNumber,
      req.body?.title,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationRuleSourceRouter.get(
  '/:organizationId/rule-sources',
  requireOrganizationPermission(organizationIdFromRouteParam, 'rule_source.read'),
  async (req, res) => {
    const result = await listRuleSources(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

ruleSourceRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingRuleSource, 'rule_source.read'),
  async (req, res) => {
    const result = await getRuleSource(ruleSourceIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

ruleSourceRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingRuleSource, 'rule_source.update'),
  async (req, res) => {
    const result = await updateRuleSource(
      ruleSourceIdFromParams(req),
      req.body?.jurisdictionCode,
      req.body?.issuingAuthority,
      req.body?.sourceCategory,
      req.body?.referenceNumber,
      req.body?.title,
      hasImmutableFieldAttempt(req.body),
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleSourceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
