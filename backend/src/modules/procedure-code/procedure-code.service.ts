import { getOrganization } from '../organization/organization.service.ts'
import type { ProcedureCodeDto, ProcedureCodeResult } from './procedure-code.types.ts'
import {
  isProcedureCodeUuid,
  normalizeOptionalCodeField,
  normalizeProcedureCodeDisplayName,
  normalizeProcedureCodeInternalCode,
} from './procedure-code.validation.ts'
import {
  createProcedureCodeRecord,
  findProcedureCodesByOrganizationId,
  findProcedureCodeById,
  updateProcedureCodeRecord,
} from './procedure-code.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { procedureCodeAuditSnapshot } from '../audit/audit.snapshot.ts'

type ProcedureCodeRecord = {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  codeSystem: string | null
  externalCode: string | null
  createdAt: Date
  updatedAt: Date
}

function toDto(record: ProcedureCodeRecord): ProcedureCodeDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    internalCode: record.internalCode,
    displayName: record.displayName,
    codeSystem: record.codeSystem,
    externalCode: record.externalCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createProcedureCode(
  organizationId: string,
  internalCodeInput: unknown,
  displayNameInput: unknown,
  codeSystemInput: unknown,
  externalCodeInput: unknown,
  actorUserId: string,
): Promise<ProcedureCodeResult<ProcedureCodeDto>> {
  if (!isProcedureCodeUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const internalCode = normalizeProcedureCodeInternalCode(internalCodeInput)
  if (!internalCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode is required' }

  const displayName = normalizeProcedureCodeDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const codeSystemResult = normalizeOptionalCodeField(codeSystemInput)
  if (!codeSystemResult.ok) return { ok: false, code: 'VALIDATION_ERROR', message: 'codeSystem must be a string' }

  const externalCodeResult = normalizeOptionalCodeField(externalCodeInput)
  if (!externalCodeResult.ok) return { ok: false, code: 'VALIDATION_ERROR', message: 'externalCode must be a string' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createProcedureCodeRecord(
        organizationId,
        internalCode,
        displayName,
        codeSystemResult.value,
        externalCodeResult.value,
        tx,
      )

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'procedure_code.created',
          entityType: 'PROCEDURE_CODE',
          entityId: record.id,
          beforeState: null,
          afterState: procedureCodeAuditSnapshot(record),
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

export async function getProcedureCode(id: string): Promise<ProcedureCodeResult<ProcedureCodeDto>> {
  if (!isProcedureCodeUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid procedure code id' }
  const record = await findProcedureCodeById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'procedure code not found' }
  return { ok: true, value: toDto(record) }
}

export async function listProcedureCodes(organizationId: string): Promise<ProcedureCodeResult<ProcedureCodeDto[]>> {
  if (!isProcedureCodeUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findProcedureCodesByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateProcedureCode(
  id: string,
  internalCodeInput: unknown,
  displayNameInput: unknown,
  codeSystemInput: unknown,
  externalCodeInput: unknown,
  actorUserId: string,
): Promise<ProcedureCodeResult<ProcedureCodeDto>> {
  if (!isProcedureCodeUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid procedure code id' }

  const hasInternalCode = internalCodeInput !== undefined
  const hasDisplayName = displayNameInput !== undefined
  const hasCodeSystem = codeSystemInput !== undefined
  const hasExternalCode = externalCodeInput !== undefined

  if (!hasInternalCode && !hasDisplayName && !hasCodeSystem && !hasExternalCode)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let internalCode: string | null = null
  if (hasInternalCode) {
    internalCode = normalizeProcedureCodeInternalCode(internalCodeInput)
    if (!internalCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode is required' }
  }

  let displayName: string | null = null
  if (hasDisplayName) {
    displayName = normalizeProcedureCodeDisplayName(displayNameInput)
    if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }
  }

  let codeSystem: string | null = null
  if (hasCodeSystem) {
    const result = normalizeOptionalCodeField(codeSystemInput)
    if (!result.ok) return { ok: false, code: 'VALIDATION_ERROR', message: 'codeSystem must be a string' }
    codeSystem = result.value
  }

  let externalCode: string | null = null
  if (hasExternalCode) {
    const result = normalizeOptionalCodeField(externalCodeInput)
    if (!result.ok) return { ok: false, code: 'VALIDATION_ERROR', message: 'externalCode must be a string' }
    externalCode = result.value
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await findProcedureCodeById(id, tx)
      if (!existing) return null

      const record = await updateProcedureCodeRecord(
        id,
        {
          ...(hasInternalCode ? { internalCode: internalCode! } : {}),
          ...(hasDisplayName ? { displayName: displayName! } : {}),
          ...(hasCodeSystem ? { codeSystem } : {}),
          ...(hasExternalCode ? { externalCode } : {}),
        },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId: existing.organizationId,
          actorUserId,
          actionCode: 'procedure_code.updated',
          entityType: 'PROCEDURE_CODE',
          entityId: id,
          beforeState: procedureCodeAuditSnapshot(existing),
          afterState: procedureCodeAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'procedure code not found' }

    return { ok: true, value: toDto(updated) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'internalCode already exists for this organization' }
    throw error
  }
}
