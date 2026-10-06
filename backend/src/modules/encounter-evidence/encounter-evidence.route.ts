import { Router, type Request } from 'express'
import { createEncounterEvidenceLink, getEncounterEvidenceLink, listEncounterEvidenceLinks, removeEncounterEvidenceLink } from './encounter-evidence.service.ts'
import { findEncounterOwnership, findLinkOwnership } from './encounter-evidence.repository.ts'
import { isEvidenceRequirementUuid } from '../evidence-requirement/evidence-requirement.validation.ts'
import { statusForEvidenceError } from '../evidence-requirement/evidence-requirement.route.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.6 — Encounter evidence links. Create, list active, read one (even removed), and remove once.
// There is no PATCH and no DELETE, and no upload or download: A5.1 remains the storage owner.

export const encounterEvidenceLinksRouter = Router()
export const encounterEvidenceLinkRouter = Router()

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = String(req.params.encounterId)
  if (!isEvidenceRequirementUuid(id)) return null
  return (await findEncounterOwnership(id))?.patient.organizationId ?? null
}

async function organizationIdFromLink(req: Request): Promise<string | null> {
  const id = String(req.params.linkId)
  if (!isEvidenceRequirementUuid(id)) return null
  return (await findLinkOwnership(id))?.encounter.patient.organizationId ?? null
}

encounterEvidenceLinksRouter.post(
  '/:encounterId/evidence-links',
  requireOrganizationPermission(organizationIdFromEncounter, 'encounterEvidence.create'),
  async (req, res) => {
    const result = await createEncounterEvidenceLink(String(req.params.encounterId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

encounterEvidenceLinksRouter.get(
  '/:encounterId/evidence-links',
  requireOrganizationPermission(organizationIdFromEncounter, 'encounterEvidence.read'),
  async (req, res) => {
    const result = await listEncounterEvidenceLinks(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

encounterEvidenceLinkRouter.get(
  '/:linkId',
  requireOrganizationPermission(organizationIdFromLink, 'encounterEvidence.read'),
  async (req, res) => {
    const result = await getEncounterEvidenceLink(String(req.params.linkId))
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

encounterEvidenceLinkRouter.post(
  '/:linkId/remove',
  requireOrganizationPermission(organizationIdFromLink, 'encounterEvidence.update'),
  async (req, res) => {
    const result = await removeEncounterEvidenceLink(String(req.params.linkId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForEvidenceError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
