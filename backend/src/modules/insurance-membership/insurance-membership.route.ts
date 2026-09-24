import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'
import { findMembershipOwnership, findPatientOwnership } from './insurance-membership.repository.ts'
import { createMembership, getMembership, listMemberships, updateMembership } from './insurance-membership.service.ts'
import type { InsuranceMembershipErrorCode } from './insurance-membership.types.ts'
import { isMembershipUuid } from './insurance-membership.validation.ts'

// A4.3 §11 — exactly four routes. There is deliberately no DELETE (history is kept), no
// eligibility/verify endpoint, no primary/secondary endpoint and no claim or encounter sub-route.

export const patientInsuranceMembershipRouter = Router()
export const insuranceMembershipRouter = Router()

function statusFor(code: InsuranceMembershipErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

const idParam = (req: Request) => String(req.params.id)
const patientIdParam = (req: Request) => String(req.params.patientId)

// Ownership is resolved before authorization and reads the owning organization ONLY — no patient
// demographic and no member/policy identifier is fetched for a caller who is not yet authorized.
// A malformed id never reaches the database at all.
async function organizationIdFromPatient(req: Request): Promise<string | null> {
  const id = patientIdParam(req)
  if (!isMembershipUuid(id)) return null
  return (await findPatientOwnership(id))?.organizationId ?? null
}

async function organizationIdFromMembership(req: Request): Promise<string | null> {
  const id = idParam(req)
  if (!isMembershipUuid(id)) return null
  return (await findMembershipOwnership(id))?.organizationId ?? null
}

patientInsuranceMembershipRouter.post(
  '/:patientId/insurance-memberships',
  requireOrganizationPermission(organizationIdFromPatient, 'insuranceMembership.create'),
  async (req, res) => {
    const result = await createMembership(patientIdParam(req), req.body, String(res.locals.actorUserId))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(201).json(result.value)
  },
)

patientInsuranceMembershipRouter.get(
  '/:patientId/insurance-memberships',
  requireOrganizationPermission(organizationIdFromPatient, 'insuranceMembership.read'),
  async (req, res) => {
    const result = await listMemberships(patientIdParam(req))
    if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
    res.status(200).json({ items: result.value })
  },
)

insuranceMembershipRouter.get('/:id', requireOrganizationPermission(organizationIdFromMembership, 'insuranceMembership.read'), async (req, res) => {
  const result = await getMembership(idParam(req))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})

insuranceMembershipRouter.patch('/:id', requireOrganizationPermission(organizationIdFromMembership, 'insuranceMembership.update'), async (req, res) => {
  const result = await updateMembership(idParam(req), req.body, String(res.locals.actorUserId))
  if (!result.ok) return sendApiError(res, statusFor(result.code), result.code, result.message)
  res.status(200).json(result.value)
})
