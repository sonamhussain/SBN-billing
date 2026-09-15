import { getOrganization } from '../organization/organization.service.ts'
import { findPayerById } from '../payer/payer.repository.ts'
import { findNetworkById } from '../network/network.repository.ts'
import type {
  InsuranceProductDto,
  InsuranceProductResult,
  ProductNetworkDto,
} from './insurance-product.types.ts'
import { isCommercialContextUuid, normalizeCommercialDisplayName, normalizeCommercialKey } from './commercial-context.validation.ts'
import {
  createInsuranceProductRecord,
  createProductNetworkRecord,
  findInsuranceProductById,
  findInsuranceProductsByOrganizationId,
  findProductNetworkById,
  findProductNetworksByProductId,
  updateInsuranceProductDisplayName,
} from './insurance-product.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { insuranceProductAuditSnapshot, productNetworkAuditSnapshot } from '../audit/audit.snapshot.ts'

type InsuranceProductRecord = {
  id: string
  organizationId: string
  payerId: string
  productCode: string
  displayName: string
  createdAt: Date
  updatedAt: Date
}

type ProductNetworkRecord = { id: string; insuranceProductId: string; networkId: string; createdAt: Date }

function toDto(record: InsuranceProductRecord): InsuranceProductDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    payerId: record.payerId,
    productCode: record.productCode,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toProductNetworkDto(record: ProductNetworkRecord): ProductNetworkDto {
  return {
    id: record.id,
    insuranceProductId: record.insuranceProductId,
    networkId: record.networkId,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createInsuranceProduct(
  organizationId: string,
  payerIdInput: unknown,
  productCodeInput: unknown,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<InsuranceProductResult<InsuranceProductDto>> {
  if (!isCommercialContextUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  if (typeof payerIdInput !== 'string' || !isCommercialContextUuid(payerIdInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'payerId must be a valid UUID' }
  const payerId = payerIdInput

  const productCode = normalizeCommercialKey(productCodeInput)
  if (!productCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'productCode is required' }

  const displayName = normalizeCommercialDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code, message: organization.message }

  const payer = await findPayerById(payerId)
  if (!payer) return { ok: false, code: 'NOT_FOUND', message: 'payer not found' }
  if (payer.organizationId !== organizationId)
    return { ok: false, code: 'FORBIDDEN', message: 'payer belongs to a different organization' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createInsuranceProductRecord({ organizationId, payerId, productCode, displayName }, tx)

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'insurance_product.created',
          entityType: 'INSURANCE_PRODUCT',
          entityId: record.id,
          beforeState: null,
          afterState: insuranceProductAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'productCode already exists for this organization' }
    throw error
  }
}

export async function getInsuranceProduct(id: string): Promise<InsuranceProductResult<InsuranceProductDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid insurance product id' }
  const record = await findInsuranceProductById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'insurance product not found' }
  return { ok: true, value: toDto(record) }
}

export async function listInsuranceProducts(organizationId: string): Promise<InsuranceProductResult<InsuranceProductDto[]>> {
  if (!isCommercialContextUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code, message: organization.message }

  const records = await findInsuranceProductsByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateInsuranceProduct(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<InsuranceProductResult<InsuranceProductDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid insurance product id' }
  const displayName = normalizeCommercialDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findInsuranceProductById(id, tx)
    if (!existing) return null

    const record = await updateInsuranceProductDisplayName(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'insurance_product.updated',
        entityType: 'INSURANCE_PRODUCT',
        entityId: id,
        beforeState: insuranceProductAuditSnapshot(existing),
        afterState: insuranceProductAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'insurance product not found' }
  return { ok: true, value: toDto(updated) }
}

export async function createProductNetwork(
  insuranceProductId: string,
  networkIdInput: unknown,
  actorUserId: string,
): Promise<InsuranceProductResult<ProductNetworkDto>> {
  if (!isCommercialContextUuid(insuranceProductId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid insurance product id' }

  if (typeof networkIdInput !== 'string' || !isCommercialContextUuid(networkIdInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'networkId must be a valid UUID' }
  const networkId = networkIdInput

  const product = await findInsuranceProductById(insuranceProductId)
  if (!product) return { ok: false, code: 'NOT_FOUND', message: 'insurance product not found' }

  const network = await findNetworkById(networkId)
  if (!network) return { ok: false, code: 'NOT_FOUND', message: 'network not found' }
  if (network.organizationId !== product.organizationId)
    return { ok: false, code: 'FORBIDDEN', message: 'network belongs to a different organization' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createProductNetworkRecord({ insuranceProductId, networkId }, tx)

      await recordAuditEvent(
        {
          organizationId: product.organizationId,
          actorUserId,
          actionCode: 'product_network.created',
          entityType: 'PRODUCT_NETWORK',
          entityId: record.id,
          beforeState: null,
          afterState: productNetworkAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toProductNetworkDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'this network is already linked to this insurance product' }
    throw error
  }
}

export async function getProductNetwork(id: string): Promise<InsuranceProductResult<ProductNetworkDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid product network id' }
  const record = await findProductNetworkById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'product network not found' }
  return { ok: true, value: toProductNetworkDto(record) }
}

export async function listProductNetworks(insuranceProductId: string): Promise<InsuranceProductResult<ProductNetworkDto[]>> {
  if (!isCommercialContextUuid(insuranceProductId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid insurance product id' }

  const product = await findInsuranceProductById(insuranceProductId)
  if (!product) return { ok: false, code: 'NOT_FOUND', message: 'insurance product not found' }

  const records = await findProductNetworksByProductId(insuranceProductId)
  return { ok: true, value: records.map(toProductNetworkDto) }
}
