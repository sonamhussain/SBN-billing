import { findRuleSourceById } from '../rule-source/rule-source.repository.ts'
import type { RuleSourceVersionDto, RuleSourceVersionResult } from './rule-source-version.types.ts'
import { isRuleSourceVersionUuid, normalizeRawEvidenceRef, normalizeVersion } from './rule-source-version.validation.ts'
import {
  createRuleSourceVersionRecord,
  findRuleSourceVersionById,
  findRuleSourceVersionsBySourceId,
} from './rule-source-version.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleSourceVersionAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleSourceVersionRecord = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: RuleSourceVersionRecord): RuleSourceVersionDto {
  return {
    id: record.id,
    sourceId: record.sourceId,
    version: record.version,
    rawEvidenceRef: record.rawEvidenceRef,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createRuleSourceVersion(
  sourceId: string,
  versionInput: unknown,
  rawEvidenceRefInput: unknown,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(sourceId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source id' }

  const version = normalizeVersion(versionInput)
  if (!version) return { ok: false, code: 'VALIDATION_ERROR', message: 'version is required' }

  const rawEvidenceRef = normalizeRawEvidenceRef(rawEvidenceRefInput)
  if (!rawEvidenceRef) return { ok: false, code: 'VALIDATION_ERROR', message: 'rawEvidenceRef is required' }

  const source = await findRuleSourceById(sourceId)
  if (!source) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createRuleSourceVersionRecord({ sourceId, version, rawEvidenceRef }, tx)

      await recordAuditEvent(
        {
          organizationId: source.organizationId as string,
          actorUserId,
          actionCode: 'rule_source_version.created',
          entityType: 'RULE_SOURCE_VERSION',
          entityId: record.id,
          beforeState: null,
          afterState: ruleSourceVersionAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'version already exists for this rule source' }
    throw error
  }
}

export async function getRuleSourceVersion(id: string): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }
  const record = await findRuleSourceVersionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleSourceVersions(sourceId: string): Promise<RuleSourceVersionResult<RuleSourceVersionDto[]>> {
  if (!isRuleSourceVersionUuid(sourceId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source id' }

  const source = await findRuleSourceById(sourceId)
  if (!source) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }

  const records = await findRuleSourceVersionsBySourceId(sourceId)
  return { ok: true, value: records.map(toDto) }
}
