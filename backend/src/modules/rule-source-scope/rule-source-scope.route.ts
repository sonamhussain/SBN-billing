import { Router, type Request } from 'express'
import type { RuleSourceScopeErrorCode } from './rule-source-scope.types.ts'
import { createRuleSourceScope, getRuleSourceScope, listRuleSourceScopes } from './rule-source-scope.service.ts'
import { findRuleSourceScopeWithSource } from './rule-source-scope.repository.ts'
import { findRuleSourceById } from '../rule-source/rule-source.repository.ts'
import { isRuleSourceScopeUuid, scopeDimensionKeys, type ScopeDimensionKey } from './rule-source-scope.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const sourceScopesRouter = Router()
export const ruleSourceScopeRouter = Router()

function statusForError(code: RuleSourceScopeErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function sourceIdFromParams(req: Request): string {
  return String(req.params.sourceId)
}

function scopeIdFromParams(req: Request): string {
  return String(req.params.id)
}

function dimensionInputsFromBody(body: unknown): Record<ScopeDimensionKey, unknown> {
  const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const result = {} as Record<ScopeDimensionKey, unknown>
  for (const key of scopeDimensionKeys) result[key] = source[key]
  return result
}

async function organizationIdFromParentSource(req: Request): Promise<string | null> {
  const sourceId = sourceIdFromParams(req)
  if (!isRuleSourceScopeUuid(sourceId)) return null
  const source = await findRuleSourceById(sourceId)
  return source?.organizationId ?? null
}

async function organizationIdFromExistingScope(req: Request): Promise<string | null> {
  const id = scopeIdFromParams(req)
  if (!isRuleSourceScopeUuid(id)) return null
  const scope = await findRuleSourceScopeWithSource(id)
  return scope?.source.organizationId ?? null
}

sourceScopesRouter.post(
  '/:sourceId/scopes',
  requireOrganizationPermission(organizationIdFromParentSource, 'rule_source_scope.create'),
  async (req, res) => {
    const result = await createRuleSourceScope(sourceIdFromParams(req), dimensionInputsFromBody(req.body), String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

sourceScopesRouter.get(
  '/:sourceId/scopes',
  requireOrganizationPermission(organizationIdFromParentSource, 'rule_source_scope.read'),
  async (req, res) => {
    const result = await listRuleSourceScopes(sourceIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

ruleSourceScopeRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingScope, 'rule_source_scope.read'),
  async (req, res) => {
    const result = await getRuleSourceScope(scopeIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
