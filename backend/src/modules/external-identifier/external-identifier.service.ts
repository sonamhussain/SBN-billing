import { getOrganization } from '../organization/organization.service.ts'
import type { ExternalIdentifierDto, ExternalIdentifierResult } from './external-identifier.types.ts'
import { isExternalIdentifierUuid, normalizeExternalValue, normalizeSourceSystem } from './external-identifier.validation.ts'
import { deriveTargetFromRecord, resolveTarget, targetForeignKeyColumn, type PersistedTargetColumns } from './external-identifier.target.ts'
import {
  createExternalIdentifierRecord,
  findExternalIdentifiersByOrganizationId,
  findExternalIdentifierById,
  updateExternalIdentifierRecord,
} from './external-identifier.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { externalIdentifierAuditSnapshot } from '../audit/audit.snapshot.ts'

type ExternalIdentifierRecord = PersistedTargetColumns & {
  id: string
  organizationId: string
  sourceSystem: string
  externalValue: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: ExternalIdentifierRecord): ExternalIdentifierDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    sourceSystem: record.sourceSystem,
    externalValue: record.externalValue,
    target: deriveTargetFromRecord(record),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createExternalIdentifier(
  organizationId: string,
  sourceSystemInput: unknown,
  externalValueInput: unknown,
  targetInput: unknown,
  actorUserId: string,
): Promise<ExternalIdentifierResult<ExternalIdentifierDto>> {
  if (!isExternalIdentifierUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const sourceSystem = normalizeSourceSystem(sourceSystemInput)
  if (!sourceSystem) return { ok: false, code: 'VALIDATION_ERROR', message: 'sourceSystem is required' }

  const externalValue = normalizeExternalValue(externalValueInput)
  if (!externalValue) return { ok: false, code: 'VALIDATION_ERROR', message: 'externalValue is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  type TxOutcome =
    | { kind: 'created'; record: ExternalIdentifierRecord }
    | { kind: 'target_invalid' }
    | { kind: 'target_not_found' }
    | { kind: 'target_forbidden' }

  try {
    const outcome = await prisma.$transaction(async (tx): Promise<TxOutcome> => {
      const resolved = await resolveTarget(targetInput, tx)
      if (!resolved.ok) {
        return resolved.reason === 'NOT_FOUND' ? { kind: 'target_not_found' } : { kind: 'target_invalid' }
      }

      if (resolved.target.organizationId !== organizationId) return { kind: 'target_forbidden' }

      const record = await createExternalIdentifierRecord(
        {
          organizationId,
          sourceSystem,
          externalValue,
          [targetForeignKeyColumn(resolved.target.type)]: resolved.target.id,
        },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'external_identifier.created',
          entityType: 'EXTERNAL_IDENTIFIER',
          entityId: record.id,
          beforeState: null,
          afterState: externalIdentifierAuditSnapshot(record),
        },
        tx,
      )

      return { kind: 'created', record }
    })

    if (outcome.kind === 'target_not_found') return { ok: false, code: 'NOT_FOUND', message: 'target not found' }
    if (outcome.kind === 'target_invalid') return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid target' }
    if (outcome.kind === 'target_forbidden')
      return { ok: false, code: 'FORBIDDEN', message: 'target does not belong to this organization' }

    return { ok: true, value: toDto(outcome.record) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'externalValue already exists for this sourceSystem in this organization',
      }
    throw error
  }
}

export async function getExternalIdentifier(id: string): Promise<ExternalIdentifierResult<ExternalIdentifierDto>> {
  if (!isExternalIdentifierUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid external identifier id' }
  const record = await findExternalIdentifierById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'external identifier not found' }
  return { ok: true, value: toDto(record) }
}

export async function listExternalIdentifiers(
  organizationId: string,
): Promise<ExternalIdentifierResult<ExternalIdentifierDto[]>> {
  if (!isExternalIdentifierUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findExternalIdentifiersByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateExternalIdentifier(
  id: string,
  sourceSystemInput: unknown,
  externalValueInput: unknown,
  targetInput: unknown,
  targetTypeInput: unknown,
  targetIdInput: unknown,
  actorUserId: string,
): Promise<ExternalIdentifierResult<ExternalIdentifierDto>> {
  if (!isExternalIdentifierUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid external identifier id' }

  if (targetInput !== undefined || targetTypeInput !== undefined || targetIdInput !== undefined)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'target cannot be changed' }

  const hasSourceSystem = sourceSystemInput !== undefined
  const hasExternalValue = externalValueInput !== undefined

  if (!hasSourceSystem && !hasExternalValue)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let sourceSystem: string | null = null
  if (hasSourceSystem) {
    sourceSystem = normalizeSourceSystem(sourceSystemInput)
    if (!sourceSystem) return { ok: false, code: 'VALIDATION_ERROR', message: 'sourceSystem is required' }
  }

  let externalValue: string | null = null
  if (hasExternalValue) {
    externalValue = normalizeExternalValue(externalValueInput)
    if (!externalValue) return { ok: false, code: 'VALIDATION_ERROR', message: 'externalValue is required' }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await findExternalIdentifierById(id, tx)
      if (!existing) return null

      const record = await updateExternalIdentifierRecord(
        id,
        {
          ...(sourceSystem ? { sourceSystem } : {}),
          ...(externalValue ? { externalValue } : {}),
        },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId: existing.organizationId,
          actorUserId,
          actionCode: 'external_identifier.updated',
          entityType: 'EXTERNAL_IDENTIFIER',
          entityId: id,
          beforeState: externalIdentifierAuditSnapshot(existing),
          afterState: externalIdentifierAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'external identifier not found' }

    return { ok: true, value: toDto(updated) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'externalValue already exists for this sourceSystem in this organization',
      }
    throw error
  }
}
