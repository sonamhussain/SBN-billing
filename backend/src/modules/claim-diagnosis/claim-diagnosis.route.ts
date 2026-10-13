import { Router, type Request } from 'express'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { organizationIdFromClaim, requireStructureUuidParam, sendClaimStructureResult } from '../claim-line/claim-line.route.ts'
import { findClaimDiagnosisOwnership } from './claim-diagnosis.repository.ts'
import { createClaimDiagnosis, listClaimDiagnoses, removeClaimDiagnosis, reorderClaimDiagnoses } from './claim-diagnosis.service.ts'

// A6.2 §12 — ClaimDiagnosis routes. Ownership resolves through Claim -> Encounter -> Patient ->
// Organization first; another tenant's Claim or diagnosis is denied without disclosing a source, role
// or position. There is no DELETE and no role overwrite: a role correction is remove + re-add.

export const claimDiagnosesRouter = Router()
export const claimDiagnosisRouter = Router()

async function organizationIdFromDiagnosis(req: Request): Promise<string | null> {
  return (await findClaimDiagnosisOwnership(String(req.params.claimDiagnosisId)))?.organizationId ?? null
}

claimDiagnosesRouter.post(
  '/:claimId/diagnoses',
  requireStructureUuidParam('claimId', 'claim'),
  requireOrganizationPermission(organizationIdFromClaim, 'claimDiagnosis.create'),
  async (req, res) => {
    sendClaimStructureResult(res, await createClaimDiagnosis(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 201)
  },
)

claimDiagnosesRouter.get('/:claimId/diagnoses', requireStructureUuidParam('claimId', 'claim'), requireOrganizationPermission(organizationIdFromClaim, 'claimDiagnosis.read'), async (req, res) => {
  sendClaimStructureResult(res, await listClaimDiagnoses(String(req.params.claimId)), 200)
})

claimDiagnosesRouter.put(
  '/:claimId/diagnoses/order',
  requireStructureUuidParam('claimId', 'claim'),
  requireOrganizationPermission(organizationIdFromClaim, 'claimDiagnosis.update'),
  async (req, res) => {
    sendClaimStructureResult(res, await reorderClaimDiagnoses(String(req.params.claimId), req.body, String(res.locals.actorUserId)), 200)
  },
)

claimDiagnosisRouter.post(
  '/:claimDiagnosisId/remove',
  requireStructureUuidParam('claimDiagnosisId', 'claim diagnosis'),
  requireOrganizationPermission(organizationIdFromDiagnosis, 'claimDiagnosis.update'),
  async (req, res) => {
    sendClaimStructureResult(res, await removeClaimDiagnosis(String(req.params.claimDiagnosisId), req.body, String(res.locals.actorUserId)), 200)
  },
)
