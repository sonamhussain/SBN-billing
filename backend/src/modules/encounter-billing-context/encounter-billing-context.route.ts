import { Router, type NextFunction, type Request, type Response } from 'express'
import type { EncounterBillingContextErrorCode } from './encounter-billing-context.types.ts'
import { loadEncounterBillingContext } from './encounter-billing-context.service.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import { isEncounterBillingContextUuid } from './encounter-billing-context.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A4.9 — exactly one route, and it only reads.
//
// There is no POST, PATCH, PUT or DELETE here and there never will be: the billing context is an
// ephemeral view of what A4.1-A4.8 already own, so there is nothing for a caller to create or
// change through it. There are also no query flags. A flag such as `?asOf=` or `?latest=true` would
// let a caller alter which truth comes back, and the exact stored provider and regulatory bindings
// are not negotiable.

export const encounterBillingContextRouter = Router()

function statusForError(code: EncounterBillingContextErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  // A contradiction between stored rows is not the caller's mistake and not a missing resource:
  // it is a conflict in the data itself, which is what 409 says.
  if (code === 'INTEGRITY_CONFLICT') return 409
  return 400
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const encounterId = String(req.params.encounterId)
  if (!isEncounterBillingContextUuid(encounterId)) return null
  return (await findEncounterOwnership(encounterId))?.organizationId ?? null
}

// A malformed id is answered before authorization runs. Ownership lookup cannot distinguish "not a
// UUID" from "no such encounter", so without this the caller would get 404 for a request that was
// simply malformed. Nothing is disclosed by saying so: a string that cannot be a UUID cannot name a
// resource, so there is no existence to leak.
function rejectMalformedEncounterId(req: Request, res: Response, next: NextFunction) {
  if (!isEncounterBillingContextUuid(String(req.params.encounterId))) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'invalid encounter id')
    return
  }
  next()
}

encounterBillingContextRouter.get(
  '/:encounterId/billing-context',
  rejectMalformedEncounterId,
  // The dedicated aggregate permission, never `encounter.read`. One response here discloses patient
  // identity, the selected membership and every active clinical and billing fact together, which is
  // a materially larger disclosure than any one of its parts.
  requireOrganizationPermission(organizationIdFromEncounter, 'encounterBillingContext.read'),
  async (req, res) => {
    const result = await loadEncounterBillingContext(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
