import { getOrganization } from '../organization/organization.service.ts'
import type { ClinicianDto, ClinicianResult } from './clinician.types.ts'
import { isClinicianUuid, normalizeClinicianDisplayName } from './clinician.validation.ts'
import {
  createClinicianRecord,
  findCliniciansByOrganizationId,
  findClinicianById,
  updateClinicianRecord,
} from './clinician.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { clinicianAuditSnapshot } from '../audit/audit.snapshot.ts'

type ClinicianRecord = { id: string; organizationId: string; displayName: string; createdAt: Date; updatedAt: Date }

function toDto(record: ClinicianRecord): ClinicianDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createClinician(
  organizationId: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<ClinicianResult<ClinicianDto>> {
  if (!isClinicianUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const displayName = normalizeClinicianDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createClinicianRecord(organizationId, displayName, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'clinician.created',
        entityType: 'CLINICIAN',
        entityId: record.id,
        beforeState: null,
        afterState: clinicianAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getClinician(id: string): Promise<ClinicianResult<ClinicianDto>> {
  if (!isClinicianUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid clinician id' }
  const record = await findClinicianById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'clinician not found' }
  return { ok: true, value: toDto(record) }
}

export async function listClinicians(organizationId: string): Promise<ClinicianResult<ClinicianDto[]>> {
  if (!isClinicianUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findCliniciansByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateClinician(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<ClinicianResult<ClinicianDto>> {
  if (!isClinicianUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid clinician id' }
  const displayName = normalizeClinicianDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findClinicianById(id, tx)
    if (!existing) return null

    const record = await updateClinicianRecord(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'clinician.updated',
        entityType: 'CLINICIAN',
        entityId: id,
        beforeState: clinicianAuditSnapshot(existing),
        afterState: clinicianAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'clinician not found' }

  return { ok: true, value: toDto(updated) }
}
