import type { OrganizationDto, ServiceResult } from './organization.types.ts'
import { isUuid, normalizeOrganizationName } from './organization.validation.ts'
import {
  createOrganizationRecord,
  findOrganizationById,
  updateOrganizationRecord,
} from './organization.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { organizationAuditSnapshot } from '../audit/audit.snapshot.ts'

type OrganizationRecord = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: OrganizationRecord): OrganizationDto {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createOrganization(
  nameInput: unknown,
): Promise<ServiceResult<OrganizationDto>> {
  const name = normalizeOrganizationName(nameInput)

  if (!name) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }
  }

  const record = await createOrganizationRecord(name)
  return { ok: true, value: toDto(record) }
}

export async function getOrganization(
  id: string,
): Promise<ServiceResult<OrganizationDto>> {
  if (!isUuid(id)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }
  }

  const record = await findOrganizationById(id)

  if (!record) {
    return { ok: false, code: 'NOT_FOUND', message: 'organization not found' }
  }

  return { ok: true, value: toDto(record) }
}

export async function updateOrganization(
  id: string,
  nameInput: unknown,
  actorUserId: string,
): Promise<ServiceResult<OrganizationDto>> {
  if (!isUuid(id)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }
  }

  const name = normalizeOrganizationName(nameInput)

  if (!name) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findOrganizationById(id, tx)

    if (!existing) {
      return null
    }

    const record = await updateOrganizationRecord(id, name, tx)

    await recordAuditEvent(
      {
        organizationId: id,
        actorUserId,
        actionCode: 'organization.updated',
        entityType: 'ORGANIZATION',
        entityId: id,
        beforeState: organizationAuditSnapshot(existing),
        afterState: organizationAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) {
    return { ok: false, code: 'NOT_FOUND', message: 'organization not found' }
  }

  return { ok: true, value: toDto(updated) }
}
