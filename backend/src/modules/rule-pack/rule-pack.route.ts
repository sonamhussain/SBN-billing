import { Router, type Request } from 'express'
import type { RulePackErrorCode } from './rule-pack.types.ts'
import {
  activateRulePackVersion,
  addRulePackMember,
  createRulePack,
  createRulePackVersion,
  getRulePack,
  getRulePackVersion,
  listRulePackMembers,
  listRulePacks,
  listRulePackVersions,
  removeRulePackMember,
  updateRulePack,
  updateRulePackVersion,
  verifyRulePackVersion,
} from './rule-pack.service.ts'
import { findRulePackById, findRulePackMemberWithPack, findRulePackVersionWithPack } from './rule-pack.repository.ts'
import { isRulePackUuid } from './rule-pack.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A3.9 §16 — exactly the thirteen rule-pack routes and the two permissions rule_pack.read /
// rule_pack.write. There is deliberately no RulePack or RulePackVersion DELETE route, no tenant
// write path for a SYSTEM_SHARED pack (its null organization resolves to a 404 below, the
// existing shared policy), and no provenance route of any kind.

export const organizationRulePackRouter = Router()
export const rulePackRouter = Router()
export const rulePackVersionRouter = Router()
export const rulePackMemberRouter = Router()

function statusFor(code: RulePackErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function idParam(req: Request): string {
  return String(req.params.id)
}

function organizationIdParam(req: Request): string {
  return String(req.params.organizationId)
}

function bodyHasAny(body: unknown, keys: readonly string[]): boolean {
  if (typeof body !== 'object' || body === null) return false
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}

function bodyHasOtherThan(body: unknown, allowed: readonly string[]): boolean {
  if (typeof body !== 'object' || body === null) return false
  return Object.keys(body).some((key) => !allowed.includes(key))
}

// Ownership is server-derived on create; the client can never supply or change it.
const serverDerivedPackFields = ['id', 'organizationId', 'ownershipScope', 'createdAt', 'updatedAt'] as const
// Stable pack identity: only displayName may change.
const packIdentityFields = ['id', 'organizationId', 'ownershipScope', 'packKey', 'jurisdictionCode', 'createdAt', 'updatedAt'] as const
// Lifecycle is never client-authored.
const versionLifecycleFields = [
  'id',
  'rulePackId',
  'verificationStatus',
  'verifiedAt',
  'activationStatus',
  'activatedAt',
  'supersededAt',
  'createdAt',
  'updatedAt',
] as const

async function organizationIdFromPack(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isRulePackUuid(id)) return null
  const pack = await findRulePackById(id)
  return pack?.organizationId ?? null
}

async function organizationIdFromVersion(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isRulePackUuid(id)) return null
  const version = await findRulePackVersionWithPack(id)
  return version?.rulePack.organizationId ?? null
}

async function organizationIdFromMember(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isRulePackUuid(id)) return null
  const member = await findRulePackMemberWithPack(id)
  return member?.rulePackVersion.rulePack.organizationId ?? null
}

// ---- /api/organizations/:organizationId/rule-packs -----------------------------------------

organizationRulePackRouter.post(
  '/:organizationId/rule-packs',
  requireOrganizationPermission(organizationIdParam, 'rule_pack.write'),
  async (req, res) => {
    if (bodyHasAny(req.body, serverDerivedPackFields)) {
      sendApiError(res, 400, 'VALIDATION_ERROR', 'organizationId and ownershipScope are derived by the server and cannot be supplied')
      return
    }
    const result = await createRulePack(
      organizationIdParam(req),
      req.body?.packKey,
      req.body?.displayName,
      req.body?.jurisdictionCode,
      String(res.locals.actorUserId),
    )
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

organizationRulePackRouter.get(
  '/:organizationId/rule-packs',
  requireOrganizationPermission(organizationIdParam, 'rule_pack.read'),
  async (req, res) => {
    const result = await listRulePacks(organizationIdParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

// ---- /api/rule-packs/:id -------------------------------------------------------------------

rulePackRouter.get('/:id', requireOrganizationPermission(organizationIdFromPack, 'rule_pack.read'), async (req, res) => {
  const result = await getRulePack(idParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

rulePackRouter.patch('/:id', requireOrganizationPermission(organizationIdFromPack, 'rule_pack.write'), async (req, res) => {
  const result = await updateRulePack(
    idParam(req),
    req.body?.displayName,
    bodyHasAny(req.body, packIdentityFields),
    String(res.locals.actorUserId),
  )
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

rulePackRouter.post(
  '/:id/versions',
  requireOrganizationPermission(organizationIdFromPack, 'rule_pack.write'),
  async (req, res) => {
    const result = await createRulePackVersion(
      idParam(req),
      req.body?.version,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      bodyHasAny(req.body, versionLifecycleFields),
      String(res.locals.actorUserId),
    )
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

rulePackRouter.get(
  '/:id/versions',
  requireOrganizationPermission(organizationIdFromPack, 'rule_pack.read'),
  async (req, res) => {
    const result = await listRulePackVersions(idParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

// ---- /api/rule-pack-versions/:id -----------------------------------------------------------

rulePackVersionRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromVersion, 'rule_pack.read'),
  async (req, res) => {
    const result = await getRulePackVersion(idParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

rulePackVersionRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromVersion, 'rule_pack.write'),
  async (req, res) => {
    const result = await updateRulePackVersion(
      idParam(req),
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      bodyHasOtherThan(req.body, ['effectiveFrom', 'effectiveTo']),
      String(res.locals.actorUserId),
    )
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

rulePackVersionRouter.post(
  '/:id/members',
  requireOrganizationPermission(organizationIdFromVersion, 'rule_pack.write'),
  async (req, res) => {
    // Membership is an exact RuleVersion UUID and nothing else; no source, applicability or
    // context field is ever accepted into it.
    if (bodyHasOtherThan(req.body, ['ruleVersionId'])) {
      sendApiError(res, 400, 'VALIDATION_ERROR', 'a rule pack member takes only ruleVersionId')
      return
    }
    const result = await addRulePackMember(idParam(req), req.body?.ruleVersionId, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

rulePackVersionRouter.get(
  '/:id/members',
  requireOrganizationPermission(organizationIdFromVersion, 'rule_pack.read'),
  async (req, res) => {
    const result = await listRulePackMembers(idParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

rulePackVersionRouter.post(
  '/:id/verification',
  requireOrganizationPermission(organizationIdFromVersion, 'rule_pack.write'),
  async (req, res) => {
    const result = await verifyRulePackVersion(idParam(req), String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

rulePackVersionRouter.post(
  '/:id/activate',
  requireOrganizationPermission(organizationIdFromVersion, 'rule_pack.write'),
  async (req, res) => {
    const result = await activateRulePackVersion(idParam(req), req.body?.businessDate, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)

// ---- /api/rule-pack-members/:id ------------------------------------------------------------

rulePackMemberRouter.delete(
  '/:id',
  requireOrganizationPermission(organizationIdFromMember, 'rule_pack.write'),
  async (req, res) => {
    const result = await removeRulePackMember(idParam(req), String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json(result.value)
  },
)
