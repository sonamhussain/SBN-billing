import { getOrganization } from '../organization/organization.service.ts'
import type { NetworkDto, NetworkResult } from './network.types.ts'
import { isNetworkUuid, normalizeNetworkDisplayName } from './network.validation.ts'
import {
  createNetworkRecord,
  findNetworksByOrganizationId,
  findNetworkById,
  updateNetworkRecord,
} from './network.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { networkAuditSnapshot } from '../audit/audit.snapshot.ts'

type NetworkRecord = { id: string; organizationId: string; displayName: string; createdAt: Date; updatedAt: Date }

function toDto(record: NetworkRecord): NetworkDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createNetwork(
  organizationId: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<NetworkResult<NetworkDto>> {
  if (!isNetworkUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const displayName = normalizeNetworkDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createNetworkRecord(organizationId, displayName, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'network.created',
        entityType: 'NETWORK',
        entityId: record.id,
        beforeState: null,
        afterState: networkAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getNetwork(id: string): Promise<NetworkResult<NetworkDto>> {
  if (!isNetworkUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid network id' }
  const record = await findNetworkById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'network not found' }
  return { ok: true, value: toDto(record) }
}

export async function listNetworks(organizationId: string): Promise<NetworkResult<NetworkDto[]>> {
  if (!isNetworkUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findNetworksByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateNetwork(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<NetworkResult<NetworkDto>> {
  if (!isNetworkUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid network id' }
  const displayName = normalizeNetworkDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findNetworkById(id, tx)
    if (!existing) return null

    const record = await updateNetworkRecord(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'network.updated',
        entityType: 'NETWORK',
        entityId: id,
        beforeState: networkAuditSnapshot(existing),
        afterState: networkAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'network not found' }

  return { ok: true, value: toDto(updated) }
}
