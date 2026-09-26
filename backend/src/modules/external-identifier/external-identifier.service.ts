import { getOrganization } from '../organization/organization.service.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import type { ExternalIdentifierDto, ExternalIdentifierResult } from './external-identifier.types.ts'
import {
  isExternalIdentifierUuid,
  normalizeExternalValue,
  normalizeSourceSystem,
  validateUpdateBody,
} from './external-identifier.validation.ts'
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
  body: unknown,
  actorUserId: string,
): Promise<ExternalIdentifierResult<ExternalIdentifierDto>> {
  if (!isExternalIdentifierUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid external identifier id' }

  // A4.8 — the body is judged as a whole before anything is read out of it, so a legitimate field
  // can never carry an unknown or immutable one through with it. Nothing below this line runs, and
  // no transaction is opened, unless every supplied key is one this endpoint owns.
  const validated = validateUpdateBody(body)
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }

  const { sourceSystem: sourceSystemInput, externalValue: externalValueInput } = validated
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
    const outcome = await prisma.$transaction(async (tx) => {
      // Audit F08: lock before reading so the audit beforeState is the true serial predecessor.
      await lockRowForUpdate(tx, 'external_identifiers', id)
      const existing = await findExternalIdentifierById(id, tx)
      if (!existing) return { kind: 'missing' as const }
      await concurrencyProbe('external_identifier.update')

      // A4.8 — decide what actually changes against the row as it is inside this transaction.
      // A submitted value identical to the stored one is not an update: writing it would move
      // updatedAt and record an AuditEvent describing a change that never happened. For a Patient
      // or Encounter identifier the audit trail is the only evidence that survives, so it has to
      // be truthful; the same rule is applied to every target type because this is the one shared
      // update path and a false event is no more acceptable for the other ten.
      const changedFields: string[] = []
      if (sourceSystem !== null && sourceSystem !== existing.sourceSystem) changedFields.push('sourceSystem')
      if (externalValue !== null && externalValue !== existing.externalValue) changedFields.push('externalValue')
      if (changedFields.length === 0) return { kind: 'no_change' as const }

      const record = await updateExternalIdentifierRecord(
        id,
        {
          ...(changedFields.includes('sourceSystem') && sourceSystem ? { sourceSystem } : {}),
          ...(changedFields.includes('externalValue') && externalValue ? { externalValue } : {}),
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
          afterState: externalIdentifierAuditSnapshot(record, changedFields),
        },
        tx,
      )

      return { kind: 'updated' as const, record }
    })

    if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'external identifier not found' }
    if (outcome.kind === 'no_change')
      return { ok: false, code: 'VALIDATION_ERROR', message: 'the submitted values match the stored values; nothing to update' }

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
