import { getOrganization } from '../organization/organization.service.ts'
import type { DiagnosisCodeDto, DiagnosisCodeResult } from './diagnosis-code.types.ts'
import { isDiagnosisCodeUuid, normalizeDiagnosisCodeCode, normalizeDiagnosisCodeDisplayName } from './diagnosis-code.validation.ts'
import {
  createDiagnosisCodeRecord,
  findDiagnosisCodesByOrganizationId,
  findDiagnosisCodeById,
  updateDiagnosisCodeRecord,
} from './diagnosis-code.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { diagnosisCodeAuditSnapshot } from '../audit/audit.snapshot.ts'

type DiagnosisCodeRecord = {
  id: string
  organizationId: string
  code: string
  displayName: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: DiagnosisCodeRecord): DiagnosisCodeDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    code: record.code,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createDiagnosisCode(
  organizationId: string,
  codeInput: unknown,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<DiagnosisCodeResult<DiagnosisCodeDto>> {
  if (!isDiagnosisCodeUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const code = normalizeDiagnosisCodeCode(codeInput)
  if (!code) return { ok: false, code: 'VALIDATION_ERROR', message: 'code is required' }

  const displayName = normalizeDiagnosisCodeDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createDiagnosisCodeRecord(organizationId, code, displayName, tx)

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'diagnosisCode.created',
          entityType: 'DIAGNOSIS_CODE',
          entityId: record.id,
          beforeState: null,
          afterState: diagnosisCodeAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'code already exists for this organization' }
    throw error
  }
}

export async function getDiagnosisCode(id: string): Promise<DiagnosisCodeResult<DiagnosisCodeDto>> {
  if (!isDiagnosisCodeUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid diagnosis code id' }
  const record = await findDiagnosisCodeById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'diagnosis code not found' }
  return { ok: true, value: toDto(record) }
}

export async function listDiagnosisCodes(organizationId: string): Promise<DiagnosisCodeResult<DiagnosisCodeDto[]>> {
  if (!isDiagnosisCodeUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findDiagnosisCodesByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateDiagnosisCode(
  id: string,
  codeInput: unknown,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<DiagnosisCodeResult<DiagnosisCodeDto>> {
  if (!isDiagnosisCodeUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid diagnosis code id' }

  const hasCode = codeInput !== undefined
  const hasDisplayName = displayNameInput !== undefined

  if (!hasCode && !hasDisplayName)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let code: string | null = null
  if (hasCode) {
    code = normalizeDiagnosisCodeCode(codeInput)
    if (!code) return { ok: false, code: 'VALIDATION_ERROR', message: 'code is required' }
  }

  let displayName: string | null = null
  if (hasDisplayName) {
    displayName = normalizeDiagnosisCodeDisplayName(displayNameInput)
    if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await findDiagnosisCodeById(id, tx)
      if (!existing) return null

      const record = await updateDiagnosisCodeRecord(
        id,
        {
          ...(code ? { code } : {}),
          ...(displayName ? { displayName } : {}),
        },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId: existing.organizationId,
          actorUserId,
          actionCode: 'diagnosisCode.updated',
          entityType: 'DIAGNOSIS_CODE',
          entityId: id,
          beforeState: diagnosisCodeAuditSnapshot(existing),
          afterState: diagnosisCodeAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'diagnosis code not found' }

    return { ok: true, value: toDto(updated) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'code already exists for this organization' }
    throw error
  }
}
