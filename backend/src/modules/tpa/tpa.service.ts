import { getOrganization } from '../organization/organization.service.ts'
import type { TpaDto, TpaResult } from './tpa.types.ts'
import { isTpaUuid, normalizeTpaDisplayName } from './tpa.validation.ts'
import {
  createTpaRecord,
  findTpasByOrganizationId,
  findTpaById,
  updateTpaRecord,
} from './tpa.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { tpaAuditSnapshot } from '../audit/audit.snapshot.ts'

type TpaRecord = { id: string; organizationId: string; displayName: string; createdAt: Date; updatedAt: Date }

function toDto(record: TpaRecord): TpaDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createTpa(
  organizationId: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<TpaResult<TpaDto>> {
  if (!isTpaUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const displayName = normalizeTpaDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createTpaRecord(organizationId, displayName, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'tpa.created',
        entityType: 'TPA',
        entityId: record.id,
        beforeState: null,
        afterState: tpaAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getTpa(id: string): Promise<TpaResult<TpaDto>> {
  if (!isTpaUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tpa id' }
  const record = await findTpaById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'tpa not found' }
  return { ok: true, value: toDto(record) }
}

export async function listTpas(organizationId: string): Promise<TpaResult<TpaDto[]>> {
  if (!isTpaUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findTpasByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateTpa(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<TpaResult<TpaDto>> {
  if (!isTpaUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tpa id' }
  const displayName = normalizeTpaDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findTpaById(id, tx)
    if (!existing) return null

    const record = await updateTpaRecord(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'tpa.updated',
        entityType: 'TPA',
        entityId: id,
        beforeState: tpaAuditSnapshot(existing),
        afterState: tpaAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'tpa not found' }

  return { ok: true, value: toDto(updated) }
}
