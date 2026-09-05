import { getOrganization } from '../organization/organization.service.ts'
import type { SpecialtyDto, SpecialtyResult } from './specialty.types.ts'
import { isSpecialtyUuid, normalizeSpecialtyDisplayName } from './specialty.validation.ts'
import {
  createSpecialtyRecord,
  findSpecialtiesByOrganizationId,
  findSpecialtyById,
  updateSpecialtyRecord,
} from './specialty.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { specialtyAuditSnapshot } from '../audit/audit.snapshot.ts'

type SpecialtyRecord = { id: string; organizationId: string; displayName: string; createdAt: Date; updatedAt: Date }

function toDto(record: SpecialtyRecord): SpecialtyDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createSpecialty(
  organizationId: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<SpecialtyResult<SpecialtyDto>> {
  if (!isSpecialtyUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const displayName = normalizeSpecialtyDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createSpecialtyRecord(organizationId, displayName, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'specialty.created',
        entityType: 'SPECIALTY',
        entityId: record.id,
        beforeState: null,
        afterState: specialtyAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getSpecialty(id: string): Promise<SpecialtyResult<SpecialtyDto>> {
  if (!isSpecialtyUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid specialty id' }
  const record = await findSpecialtyById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'specialty not found' }
  return { ok: true, value: toDto(record) }
}

export async function listSpecialties(organizationId: string): Promise<SpecialtyResult<SpecialtyDto[]>> {
  if (!isSpecialtyUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findSpecialtiesByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateSpecialty(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<SpecialtyResult<SpecialtyDto>> {
  if (!isSpecialtyUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid specialty id' }
  const displayName = normalizeSpecialtyDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findSpecialtyById(id, tx)
    if (!existing) return null

    const record = await updateSpecialtyRecord(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'specialty.updated',
        entityType: 'SPECIALTY',
        entityId: id,
        beforeState: specialtyAuditSnapshot(existing),
        afterState: specialtyAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'specialty not found' }

  return { ok: true, value: toDto(updated) }
}
