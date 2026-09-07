import { getOrganization } from '../organization/organization.service.ts'
import type { PayerDto, PayerResult } from './payer.types.ts'
import { isPayerUuid, normalizePayerDisplayName } from './payer.validation.ts'
import {
  createPayerRecord,
  findPayersByOrganizationId,
  findPayerById,
  updatePayerRecord,
} from './payer.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { payerAuditSnapshot } from '../audit/audit.snapshot.ts'

type PayerRecord = { id: string; organizationId: string; displayName: string; createdAt: Date; updatedAt: Date }

function toDto(record: PayerRecord): PayerDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createPayer(
  organizationId: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<PayerResult<PayerDto>> {
  if (!isPayerUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const displayName = normalizePayerDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createPayerRecord(organizationId, displayName, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'payer.created',
        entityType: 'PAYER',
        entityId: record.id,
        beforeState: null,
        afterState: payerAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getPayer(id: string): Promise<PayerResult<PayerDto>> {
  if (!isPayerUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid payer id' }
  const record = await findPayerById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'payer not found' }
  return { ok: true, value: toDto(record) }
}

export async function listPayers(organizationId: string): Promise<PayerResult<PayerDto[]>> {
  if (!isPayerUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findPayersByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updatePayer(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<PayerResult<PayerDto>> {
  if (!isPayerUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid payer id' }
  const displayName = normalizePayerDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findPayerById(id, tx)
    if (!existing) return null

    const record = await updatePayerRecord(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'payer.updated',
        entityType: 'PAYER',
        entityId: id,
        beforeState: payerAuditSnapshot(existing),
        afterState: payerAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'payer not found' }

  return { ok: true, value: toDto(updated) }
}
