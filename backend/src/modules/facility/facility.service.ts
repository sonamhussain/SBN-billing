import { getOrganization } from '../organization/organization.service.ts'
import type { FacilityDto, FacilityResult } from './facility.types.ts'
import { isFacilityUuid, normalizeFacilityName } from './facility.validation.ts'
import { createFacilityRecord, findFacilityById, updateFacilityRecord } from './facility.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { facilityAuditSnapshot } from '../audit/audit.snapshot.ts'

type FacilityRecord = { id: string; organizationId: string; name: string; createdAt: Date; updatedAt: Date }

function toDto(record: FacilityRecord): FacilityDto {
  return {
    id: record.id, organizationId: record.organizationId, name: record.name,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createFacility(
  organizationId: string,
  nameInput: unknown,
  actorUserId: string,
): Promise<FacilityResult<FacilityDto>> {
  if (!isFacilityUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const name = normalizeFacilityName(nameInput)
  if (!name) return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createFacilityRecord(organizationId, name, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'facility.created',
        entityType: 'FACILITY',
        entityId: record.id,
        beforeState: null,
        afterState: facilityAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getFacility(id: string): Promise<FacilityResult<FacilityDto>> {
  if (!isFacilityUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility id' }
  const record = await findFacilityById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }
  return { ok: true, value: toDto(record) }
}

export async function updateFacility(
  id: string,
  nameInput: unknown,
  actorUserId: string,
): Promise<FacilityResult<FacilityDto>> {
  if (!isFacilityUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility id' }
  const name = normalizeFacilityName(nameInput)
  if (!name) return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }
  const existing = await findFacilityById(id)
  if (!existing) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }

  const updated = await prisma.$transaction(async (tx) => {
    const record = await updateFacilityRecord(id, name, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'facility.updated',
        entityType: 'FACILITY',
        entityId: id,
        beforeState: facilityAuditSnapshot(existing),
        afterState: facilityAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(updated) }
}
