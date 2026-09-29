import { Router, type Request } from 'express'
import type { EligibilityVerificationErrorCode } from './eligibility-verification.types.ts'
import {
  createEligibilityVerification,
  getEligibilityVerification,
  listEligibilityVerifications,
} from './eligibility-verification.service.ts'
import { findEncounterOwnership, findVerificationOwnership } from './eligibility-verification.repository.ts'
import { isVerificationUuid } from './eligibility-verification.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

// A5.2 — three routes, all of them GET or POST.
//
// There is no PATCH and no DELETE: a verification is a historical event, and correcting one means
// recording a new one. There is also no /verify endpoint and no payer transport of any kind — A5.2
// records what a verification reported, it never performs one. That belongs to A9.
//
// Ownership is resolved server-side before authorization runs, through the Encounter's Patient, and
// the projections used for it read no member identifier, policy identifier or evidence metadata.

export const encounterEligibilityVerificationRouter = Router()
export const eligibilityVerificationRouter = Router()

function statusForError(code: EligibilityVerificationErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INTERNAL_ERROR') return 500
  return 400
}

async function organizationIdFromEncounter(req: Request): Promise<string | null> {
  const id = String(req.params.encounterId)
  if (!isVerificationUuid(id)) return null
  return (await findEncounterOwnership(id))?.patient.organizationId ?? null
}

async function organizationIdFromVerification(req: Request): Promise<string | null> {
  const id = String(req.params.verificationId)
  if (!isVerificationUuid(id)) return null
  return (await findVerificationOwnership(id))?.encounter.patient.organizationId ?? null
}

encounterEligibilityVerificationRouter.post(
  '/:encounterId/eligibility-verifications',
  requireOrganizationPermission(organizationIdFromEncounter, 'eligibilityVerification.create'),
  async (req, res) => {
    // The owning organization is not passed in: the service reads it from the Encounter under the
    // same lock it takes the context snapshot from, so a caller can never bind another tenant's
    // evidence to their own verification.
    const result = await createEligibilityVerification(String(req.params.encounterId), req.body, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

encounterEligibilityVerificationRouter.get(
  '/:encounterId/eligibility-verifications',
  requireOrganizationPermission(organizationIdFromEncounter, 'eligibilityVerification.read'),
  async (req, res) => {
    const result = await listEligibilityVerifications(String(req.params.encounterId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

eligibilityVerificationRouter.get(
  '/:verificationId',
  requireOrganizationPermission(organizationIdFromVerification, 'eligibilityVerification.read'),
  async (req, res) => {
    const result = await getEligibilityVerification(String(req.params.verificationId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
