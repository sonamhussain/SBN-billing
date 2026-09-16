import { Router, type Request } from 'express'
import type { ProviderContractErrorCode } from './provider-contract.types.ts'
import {
  createContractFacility,
  createProviderContract,
  getContractFacility,
  getProviderContract,
  listContractFacilities,
  listProviderContracts,
  updateProviderContract,
} from './provider-contract.service.ts'
import { findContractFacilityWithContract, findProviderContractById } from './provider-contract.repository.ts'
import { isCommercialContextUuid } from './commercial-context.validation.ts'
import { requireOrganizationPermission } from '../../shared/authorization/require-permission.ts'
import { sendApiError } from '../../shared/errors/error-response.ts'

export const organizationProviderContractRouter = Router()
export const providerContractRouter = Router()
export const contractFacilityRouter = Router()

function statusForError(code: ProviderContractErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  return 400
}

function organizationIdFromRouteParam(req: Request): string {
  return String(req.params.organizationId)
}

function contractIdFromParams(req: Request): string {
  return String(req.params.id)
}

function contractFacilityIdFromParams(req: Request): string {
  return String(req.params.id)
}

async function organizationIdFromExistingContract(req: Request): Promise<string | null> {
  const id = contractIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const contract = await findProviderContractById(id)
  return contract?.organizationId ?? null
}

async function organizationIdFromExistingContractFacility(req: Request): Promise<string | null> {
  const id = contractFacilityIdFromParams(req)
  if (!isCommercialContextUuid(id)) return null
  const contractFacility = await findContractFacilityWithContract(id)
  return contractFacility?.providerContract.organizationId ?? null
}

organizationProviderContractRouter.post(
  '/:organizationId/provider-contracts',
  requireOrganizationPermission(organizationIdFromRouteParam, 'provider_contract.create'),
  async (req, res) => {
    const result = await createProviderContract(
      organizationIdFromRouteParam(req),
      req.body?.contractKey,
      req.body?.displayName,
      req.body?.payerId,
      req.body?.tpaId,
      req.body?.networkId,
      req.body?.insuranceProductId,
      req.body?.effectiveFrom,
      req.body?.effectiveTo,
      String(res.locals.actorUserId),
    )
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

organizationProviderContractRouter.get(
  '/:organizationId/provider-contracts',
  requireOrganizationPermission(organizationIdFromRouteParam, 'provider_contract.read'),
  async (req, res) => {
    const result = await listProviderContracts(organizationIdFromRouteParam(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

providerContractRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingContract, 'provider_contract.read'),
  async (req, res) => {
    const result = await getProviderContract(contractIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

providerContractRouter.patch(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingContract, 'provider_contract.update'),
  async (req, res) => {
    const result = await updateProviderContract(contractIdFromParams(req), req.body?.displayName, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)

providerContractRouter.post(
  '/:id/contract-facilities',
  requireOrganizationPermission(organizationIdFromExistingContract, 'contract_facility.create'),
  async (req, res) => {
    const result = await createContractFacility(contractIdFromParams(req), req.body?.facilityId, String(res.locals.actorUserId))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(201).json(result.value)
  },
)

providerContractRouter.get(
  '/:id/contract-facilities',
  requireOrganizationPermission(organizationIdFromExistingContract, 'contract_facility.read'),
  async (req, res) => {
    const result = await listContractFacilities(contractIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json({ items: result.value })
  },
)

contractFacilityRouter.get(
  '/:id',
  requireOrganizationPermission(organizationIdFromExistingContractFacility, 'contract_facility.read'),
  async (req, res) => {
    const result = await getContractFacility(contractFacilityIdFromParams(req))
    if (!result.ok) {
      sendApiError(res, statusForError(result.code), result.code, result.message)
      return
    }
    res.status(200).json(result.value)
  },
)
