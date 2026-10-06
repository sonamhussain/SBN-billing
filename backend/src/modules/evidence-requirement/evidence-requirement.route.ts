import { Router, type Request } from 'express'
import type { EvidenceRequirementErrorCode } from './evidence-requirement.types.ts'
import { createEvidenceRequirement, evaluateEvidenceCompleteness, getEvidenceRequirement } from './evidence-requirement.service.ts'
import { findRuleVersionOwnership } from './evidence-requirement.repository.ts'
import { isEvidenceRequirementUuid } from './evidence-requirement.validation.ts'
import { findEncounterOwnership } from '../encounter-evidence/encounter-evidence.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.6 — the requirement payload routes and the completeness evaluation route.
//
// A payload has no PATCH and no DELETE: it is immutable, and a correction is a new RuleVersion. A
// SYSTEM_SHARED rule version resolves to no organization, so tenant routes can neither read nor
// attach to it. Completeness is evaluated, never stored, and writes no audit.

export const ruleVersionEvidenceRequirementRouter = Router()
export const encounterEvidenceCompletenessRouter = Router()

export function statusForEvidenceError(code: EvidenceRequirementErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INTEGRITY_CONFLICT' || code === 'COMMERCIAL_CONTEXT_UNRESOLVED' || code === 'EVIDENCE_REQUIREMENT_UNRESOLVED') return 409
  return 400
}

async function organizationIdFromRuleVersion(req: Request): Promise<string | null> {
  const id = String(req.params.ruleVersionId)
  if (!isEvidenceRequirementUuid(id)) return null
  return (await findRuleVersionOwnership(id))?.rule.organizationId ?? null
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = String(req.params.encounterId)
  if (!isEvidenceRequirementUuid(id)) return null
  return (await findEncounterOwnership(id))?.patient.organizationId ?? null
}

ruleVersionEvidenceRequirementRouter.post(
  '/:ruleVersionId/evidence-requirement',
  requireOrganizationPermission(organizationIdFromRuleVersion, 'evidenceRequirement.create'),
  async (req, res) => {
    const result = await createEvidenceRequirement(String(req.params.ruleVersionId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message, result.reason)
      return
    }
    res.status(201).json(result.value)
  },
)

ruleVersionEvidenceRequirementRouter.get(
  '/:ruleVersionId/evidence-requirement',
  requireOrganizationPermission(organizationIdFromRuleVersion, 'evidenceRequirement.read'),
  async (req, res) => {
    const result = await getEvidenceRequirement(String(req.params.ruleVersionId))
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message, result.reason)
      return
    }
    res.status(200).json(result.value)
  },
)

// POST because the optional target travels in a body, never a query string — but it is a read: no
// row and no audit is written, however often it is called.
encounterEvidenceCompletenessRouter.post(
  '/:encounterId/evidence-completeness/evaluate',
  requireOrganizationPermission(organizationIdFromEncounter, 'evidenceCompleteness.evaluate'),
  async (req, res) => {
    const result = await evaluateEvidenceCompleteness(String(req.params.encounterId), req.body)
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message, result.reason)
      return
    }
    res.status(200).json(result.value)
  },
)
