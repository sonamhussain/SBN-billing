import { Router, type Request } from 'express'
import type { PreClaimCommercialContextErrorCode } from './pre-claim-commercial-context.types.ts'
import { isPreClaimUuid, resolvePreClaimCommercialContext } from './pre-claim-commercial-context.service.ts'
import { findEncounterOwnership } from './pre-claim-commercial-context.repository.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.5 — one route, GET only. There is no body and no query parameter: the business date is the
// Encounter's service date, and no caller can name a payer, facility, contract or tariff to win.
// There is no POST, PATCH or DELETE, because nothing is persisted.

export const encounterPreClaimCommercialContextRouter = Router()

function statusForError(code: PreClaimCommercialContextErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INTEGRITY_CONFLICT' || code === 'COMMERCIAL_CONTEXT_UNRESOLVED') return 409
  return 400
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = String(req.params.encounterId)
  if (!isPreClaimUuid(id)) return null
  return (await findEncounterOwnership(id))?.patient.organizationId ?? null
}

// A malformed id is a 400 before ownership is looked up, as §6 requires; everything else is decided
// by the shared A1 middleware, which resolves the owning organization first.
encounterPreClaimCommercialContextRouter.get(
  '/:encounterId/pre-claim-commercial-context',
  (req, res, next) => {
    if (!isPreClaimUuid(String(req.params.encounterId))) {
      sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid encounter id')
      return
    }
    next()
  },
  requireOrganizationPermission(organizationIdFromEncounter, 'preClaimCommercialContext.read'),
  async (req, res) => {
    const result = await resolvePreClaimCommercialContext(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message, result.reason)
      return
    }
    res.status(200).json(result.value)
  },
)
