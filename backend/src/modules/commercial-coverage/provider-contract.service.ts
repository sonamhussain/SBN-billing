import { getOrganization } from '../organization/organization.service.ts'
import { findFacilityById } from '../facility/facility.repository.ts'
import { findPayerById } from '../payer/payer.repository.ts'
import { findTpaById } from '../tpa/tpa.repository.ts'
import { findNetworkById } from '../network/network.repository.ts'
import { findInsuranceProductById, findProductNetworkByProductAndNetwork } from './insurance-product.repository.ts'
import type { ContractFacilityDto, ProviderContractDto, ProviderContractResult } from './provider-contract.types.ts'
import {
  isCommercialContextUuid,
  normalizeCommercialDisplayName,
  normalizeCommercialKey,
  normalizeOptionalCommercialUuidField,
} from './commercial-context.validation.ts'
import { normalizeDateOnlyField, normalizeBusinessDate, formatDateOnly } from '../rule-source-version/rule-source-version.validation.ts'
import {
  createContractFacilityRecord,
  createProviderContractRecord,
  findContractFacilityById,
  findContractFacilitiesByContractId,
  findProviderContractById,
  findProviderContractsByOrganizationId,
  updateProviderContractDisplayName,
} from './provider-contract.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { contractFacilityAuditSnapshot, providerContractAuditSnapshot } from '../audit/audit.snapshot.ts'

type ProviderContractRecord = {
  id: string
  organizationId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  contractKey: string
  displayName: string
  effectiveFrom: Date
  effectiveTo: Date | null
  createdAt: Date
  updatedAt: Date
}

type ContractFacilityRecord = { id: string; providerContractId: string; facilityId: string; createdAt: Date }

function toDto(record: ProviderContractRecord): ProviderContractDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    payerId: record.payerId,
    tpaId: record.tpaId,
    networkId: record.networkId,
    insuranceProductId: record.insuranceProductId,
    contractKey: record.contractKey,
    displayName: record.displayName,
    effectiveFrom: formatDateOnly(record.effectiveFrom) as string,
    effectiveTo: formatDateOnly(record.effectiveTo),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toContractFacilityDto(record: ContractFacilityRecord): ContractFacilityDto {
  return {
    id: record.id,
    providerContractId: record.providerContractId,
    facilityId: record.facilityId,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createProviderContract(
  organizationId: string,
  contractKeyInput: unknown,
  displayNameInput: unknown,
  payerIdInput: unknown,
  tpaIdInput: unknown,
  networkIdInput: unknown,
  insuranceProductIdInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
): Promise<ProviderContractResult<ProviderContractDto>> {
  if (!isCommercialContextUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const contractKey = normalizeCommercialKey(contractKeyInput)
  if (!contractKey) return { ok: false, code: 'VALIDATION_ERROR', message: 'contractKey is required' }

  const displayName = normalizeCommercialDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  if (typeof payerIdInput !== 'string' || !isCommercialContextUuid(payerIdInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'payerId must be a valid UUID' }
  const payerId = payerIdInput

  const tpaIdField = normalizeOptionalCommercialUuidField(tpaIdInput)
  if (!tpaIdField.valid) return { ok: false, code: 'VALIDATION_ERROR', message: 'tpaId must be a valid UUID or null' }

  const networkIdField = normalizeOptionalCommercialUuidField(networkIdInput)
  if (!networkIdField.valid) return { ok: false, code: 'VALIDATION_ERROR', message: 'networkId must be a valid UUID or null' }

  const insuranceProductIdField = normalizeOptionalCommercialUuidField(insuranceProductIdInput)
  if (!insuranceProductIdField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'insuranceProductId must be a valid UUID or null' }

  const effectiveFrom = normalizeBusinessDate(effectiveFromInput)
  if (!effectiveFrom) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date' }

  const effectiveToField = normalizeDateOnlyField(effectiveToInput)
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }
  const effectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : null

  if (effectiveTo && effectiveFrom.getTime() > effectiveTo.getTime())
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must not be after effectiveTo' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code, message: organization.message }

  const payer = await findPayerById(payerId)
  if (!payer) return { ok: false, code: 'NOT_FOUND', message: 'payer not found' }
  if (payer.organizationId !== organizationId)
    return { ok: false, code: 'FORBIDDEN', message: 'payer belongs to a different organization' }

  const tpaId = tpaIdField.value
  if (tpaId) {
    const tpa = await findTpaById(tpaId)
    if (!tpa) return { ok: false, code: 'NOT_FOUND', message: 'tpa not found' }
    if (tpa.organizationId !== organizationId)
      return { ok: false, code: 'FORBIDDEN', message: 'tpa belongs to a different organization' }
  }

  const networkId = networkIdField.value
  if (networkId) {
    const network = await findNetworkById(networkId)
    if (!network) return { ok: false, code: 'NOT_FOUND', message: 'network not found' }
    if (network.organizationId !== organizationId)
      return { ok: false, code: 'FORBIDDEN', message: 'network belongs to a different organization' }
  }

  const insuranceProductId = insuranceProductIdField.value
  if (insuranceProductId) {
    const product = await findInsuranceProductById(insuranceProductId)
    if (!product) return { ok: false, code: 'NOT_FOUND', message: 'insurance product not found' }
    if (product.organizationId !== organizationId)
      return { ok: false, code: 'FORBIDDEN', message: 'insurance product belongs to a different organization' }
    // T35: a product belonging to a different payer than the contract's own payer is rejected —
    // the contract's payer is authoritative, the product must actually be that payer's product.
    if (product.payerId !== payerId)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'insuranceProductId belongs to a different payer than the contract' }
  }

  // T36: naming both a product and a network requires an actual ProductNetwork relationship
  // between that exact pair — the contract may not invent a product/network combination.
  if (insuranceProductId && networkId) {
    const productNetwork = await findProductNetworkByProductAndNetwork(insuranceProductId, networkId)
    if (!productNetwork)
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'insuranceProductId and networkId have no existing ProductNetwork relationship',
      }
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createProviderContractRecord(
        { organizationId, payerId, tpaId, networkId, insuranceProductId, contractKey, displayName, effectiveFrom, effectiveTo },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'provider_contract.created',
          entityType: 'PROVIDER_CONTRACT',
          entityId: record.id,
          beforeState: null,
          afterState: providerContractAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'contractKey already exists for this organization' }
    throw error
  }
}

export async function getProviderContract(id: string): Promise<ProviderContractResult<ProviderContractDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid provider contract id' }
  const record = await findProviderContractById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'provider contract not found' }
  return { ok: true, value: toDto(record) }
}

export async function listProviderContracts(organizationId: string): Promise<ProviderContractResult<ProviderContractDto[]>> {
  if (!isCommercialContextUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code, message: organization.message }

  const records = await findProviderContractsByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateProviderContract(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<ProviderContractResult<ProviderContractDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid provider contract id' }
  const displayName = normalizeCommercialDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findProviderContractById(id, tx)
    if (!existing) return null

    const record = await updateProviderContractDisplayName(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'provider_contract.updated',
        entityType: 'PROVIDER_CONTRACT',
        entityId: id,
        beforeState: providerContractAuditSnapshot(existing),
        afterState: providerContractAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'provider contract not found' }
  return { ok: true, value: toDto(updated) }
}

export async function createContractFacility(
  providerContractId: string,
  facilityIdInput: unknown,
  actorUserId: string,
): Promise<ProviderContractResult<ContractFacilityDto>> {
  if (!isCommercialContextUuid(providerContractId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid provider contract id' }

  if (typeof facilityIdInput !== 'string' || !isCommercialContextUuid(facilityIdInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'facilityId must be a valid UUID' }
  const facilityId = facilityIdInput

  const contract = await findProviderContractById(providerContractId)
  if (!contract) return { ok: false, code: 'NOT_FOUND', message: 'provider contract not found' }

  const facility = await findFacilityById(facilityId)
  if (!facility) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }
  if (facility.organizationId !== contract.organizationId)
    return { ok: false, code: 'FORBIDDEN', message: 'facility belongs to a different organization' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createContractFacilityRecord({ providerContractId, facilityId }, tx)

      await recordAuditEvent(
        {
          organizationId: contract.organizationId,
          actorUserId,
          actionCode: 'contract_facility.created',
          entityType: 'CONTRACT_FACILITY',
          entityId: record.id,
          beforeState: null,
          afterState: contractFacilityAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toContractFacilityDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'this facility is already linked to this provider contract' }
    throw error
  }
}

export async function getContractFacility(id: string): Promise<ProviderContractResult<ContractFacilityDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid contract facility id' }
  const record = await findContractFacilityById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'contract facility not found' }
  return { ok: true, value: toContractFacilityDto(record) }
}

export async function listContractFacilities(providerContractId: string): Promise<ProviderContractResult<ContractFacilityDto[]>> {
  if (!isCommercialContextUuid(providerContractId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid provider contract id' }

  const contract = await findProviderContractById(providerContractId)
  if (!contract) return { ok: false, code: 'NOT_FOUND', message: 'provider contract not found' }

  const records = await findContractFacilitiesByContractId(providerContractId)
  return { ok: true, value: records.map(toContractFacilityDto) }
}
