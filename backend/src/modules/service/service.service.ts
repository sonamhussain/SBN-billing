import { getOrganization } from '../organization/organization.service.ts'
import type { ServiceDto, ServiceResult } from './service.types.ts'
import { isServiceUuid, normalizeServiceDisplayName, normalizeServiceInternalCode } from './service.validation.ts'
import {
  createServiceRecord,
  findServicesByOrganizationId,
  findServiceById,
  updateServiceRecord,
} from './service.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { serviceAuditSnapshot } from '../audit/audit.snapshot.ts'

type ServiceRecord = {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: ServiceRecord): ServiceDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    internalCode: record.internalCode,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createService(
  organizationId: string,
  internalCodeInput: unknown,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<ServiceResult<ServiceDto>> {
  if (!isServiceUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const internalCode = normalizeServiceInternalCode(internalCodeInput)
  if (!internalCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode is required' }

  const displayName = normalizeServiceDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createServiceRecord(organizationId, internalCode, displayName, tx)

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'service.created',
          entityType: 'SERVICE',
          entityId: record.id,
          beforeState: null,
          afterState: serviceAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode already exists for this organization' }
    throw error
  }
}

export async function getService(id: string): Promise<ServiceResult<ServiceDto>> {
  if (!isServiceUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid service id' }
  const record = await findServiceById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'service not found' }
  return { ok: true, value: toDto(record) }
}

export async function listServices(organizationId: string): Promise<ServiceResult<ServiceDto[]>> {
  if (!isServiceUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findServicesByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateService(
  id: string,
  internalCodeInput: unknown,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<ServiceResult<ServiceDto>> {
  if (!isServiceUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid service id' }

  const hasInternalCode = internalCodeInput !== undefined
  const hasDisplayName = displayNameInput !== undefined

  if (!hasInternalCode && !hasDisplayName)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let internalCode: string | null = null
  if (hasInternalCode) {
    internalCode = normalizeServiceInternalCode(internalCodeInput)
    if (!internalCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode is required' }
  }

  let displayName: string | null = null
  if (hasDisplayName) {
    displayName = normalizeServiceDisplayName(displayNameInput)
    if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await findServiceById(id, tx)
      if (!existing) return null

      const record = await updateServiceRecord(
        id,
        {
          ...(internalCode ? { internalCode } : {}),
          ...(displayName ? { displayName } : {}),
        },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId: existing.organizationId,
          actorUserId,
          actionCode: 'service.updated',
          entityType: 'SERVICE',
          entityId: id,
          beforeState: serviceAuditSnapshot(existing),
          afterState: serviceAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'service not found' }

    return { ok: true, value: toDto(updated) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode already exists for this organization' }
    throw error
  }
}
