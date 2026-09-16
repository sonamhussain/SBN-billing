import { Router, type Request } from 'express'
import type { RuleResolutionErrorCode } from './rule-resolution.types.ts'
import { evaluateRuleResolution } from './rule-resolution.service.ts'
import { findRuleDefinitionForResolution } from './rule-resolution.repository.ts'
import { forbiddenResolutionKeysPresent, isRuleResolutionUuid, resolutionContextKeys } from './rule-resolution.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const ruleDefinitionResolutionRouter = Router()

function statusForRuleResolutionError(code: RuleResolutionErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function ruleDefinitionIdFromParams(req: Request): string {
  return String(req.params.ruleDefinitionId)
}

function contextInputsFromBody(body: unknown): Record<string, unknown> {
  const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const result: Record<string, unknown> = {}
  for (const key of resolutionContextKeys) result[key] = source[key]
  return result
}

// A malformed id resolves to no organization, which the permission middleware turns into a 404 —
// never a 500 and never a probe-able difference from "exists but belongs to someone else".
// A SYSTEM_SHARED RuleDefinition (null organizationId) follows the same existing shared policy
// as every other module here: it resolves to no tenant organization and 404s.
async function organizationIdFromRuleDefinition(req: Request): Promise<string | null> {
  const id = ruleDefinitionIdFromParams(req)
  if (!isRuleResolutionUuid(id)) return null
  const ruleDefinition = await findRuleDefinitionForResolution(id)
  return ruleDefinition?.organizationId ?? null
}

// A3.8 §7/§17: read-only evaluation. There is no create/update/delete route in this module
// because the resolver persists nothing — POST is used only to carry the request context body.
ruleDefinitionResolutionRouter.post(
  '/:ruleDefinitionId/resolution/evaluate',
  requireOrganizationPermission(organizationIdFromRuleDefinition, 'rule_resolution.read'),
  async (req, res) => {
    const forbiddenKeys = forbiddenResolutionKeysPresent(req.body)
    if (forbiddenKeys.length > 0) {
      sendApiError(
        res,
        400,
        'VALIDATION_ERROR',
        `these fields are derived by the resolver and must not be supplied: ${forbiddenKeys.join(', ')}`,
      )
      return
    }

    const result = await evaluateRuleResolution(
      ruleDefinitionIdFromParams(req),
      req.body?.businessDate,
      contextInputsFromBody(req.body),
    )
    if (!result.ok) {
      sendApiError(res, statusForRuleResolutionError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
