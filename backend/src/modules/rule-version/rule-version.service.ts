import { findRuleDefinitionById } from '../rule-definition/rule-definition.repository.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import type { RuleVersionDto, RuleVersionResult } from './rule-version.types.ts'
import { isRuleVersionUuid, normalizeEffectType, normalizeVersion } from './rule-version.validation.ts'
import {
  isSourceVerificationStatus,
  normalizeDateOnlyField,
  formatDateOnly,
} from '../rule-source-version/rule-source-version.validation.ts'
import {
  createRuleVersionRecord,
  findRuleVersionById,
  findRuleVersionsByRuleId,
  findRuleVersionWithOrganization,
  updateRuleVersionRecord,
} from './rule-version.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleVersionAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleVersionRecord = {
  id: string
  ruleId: string
  version: string
  effectType: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toDto(record: RuleVersionRecord): RuleVersionDto {
  return {
    id: record.id,
    ruleId: record.ruleId,
    version: record.version,
    effectType: record.effectType,
    effectiveFrom: formatDateOnly(record.effectiveFrom),
    effectiveTo: formatDateOnly(record.effectiveTo),
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt ? record.verifiedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

// VERIFIED and REJECTED are terminal for a given RuleVersion — no working-metadata PATCH
// and no further verification transition may touch it once here (A3.5 hard gate).
const terminalVerificationStatuses: readonly string[] = ['VERIFIED', 'REJECTED']

export async function createRuleVersion(
  ruleId: string,
  versionInput: unknown,
  effectTypeInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
): Promise<RuleVersionResult<RuleVersionDto>> {
  if (!isRuleVersionUuid(ruleId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule definition id' }

  const version = normalizeVersion(versionInput)
  if (!version) return { ok: false, code: 'VALIDATION_ERROR', message: 'version is required' }

  const effectType = normalizeEffectType(effectTypeInput)
  if (!effectType) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectType is invalid' }

  const effectiveFromField = normalizeDateOnlyField(effectiveFromInput)
  const effectiveToField = normalizeDateOnlyField(effectiveToInput)
  if (effectiveFromField.present && !effectiveFromField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date or null' }
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }

  const effectiveFrom = effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value : null
  const effectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : null
  if (effectiveFrom && effectiveTo && effectiveFrom.getTime() > effectiveTo.getTime())
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must not be after effectiveTo' }

  const rule = await findRuleDefinitionById(ruleId)
  if (!rule) return { ok: false, code: 'NOT_FOUND', message: 'rule definition not found' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // New RuleVersions always start UNVERIFIED with no verifiedAt — the client
      // never supplies verificationStatus or verifiedAt on create.
      const record = await createRuleVersionRecord(
        { ruleId, version, effectType, effectiveFrom, effectiveTo },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId: rule.organizationId as string,
          actorUserId,
          actionCode: 'rule_version.created',
          entityType: 'RULE_VERSION',
          entityId: record.id,
          beforeState: null,
          afterState: ruleVersionAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'version already exists for this rule definition' }
    throw error
  }
}

export async function getRuleVersion(id: string): Promise<RuleVersionResult<RuleVersionDto>> {
  if (!isRuleVersionUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }
  const record = await findRuleVersionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleVersions(ruleId: string): Promise<RuleVersionResult<RuleVersionDto[]>> {
  if (!isRuleVersionUuid(ruleId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule definition id' }

  const rule = await findRuleDefinitionById(ruleId)
  if (!rule) return { ok: false, code: 'NOT_FOUND', message: 'rule definition not found' }

  const records = await findRuleVersionsByRuleId(ruleId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateRuleVersionMetadata(
  id: string,
  effectTypeInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  hasImmutableFieldAttempt: boolean,
  actorUserId: string,
): Promise<RuleVersionResult<RuleVersionDto>> {
  if (!isRuleVersionUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  if (hasImmutableFieldAttempt)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'id, ruleId, version, verificationStatus, verifiedAt, createdAt and updatedAt cannot be changed',
    }

  const hasEffectType = effectTypeInput !== undefined
  const effectiveFromField = normalizeDateOnlyField(effectiveFromInput)
  const effectiveToField = normalizeDateOnlyField(effectiveToInput)

  if (!hasEffectType && !effectiveFromField.present && !effectiveToField.present)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let effectType: string | null = null
  if (hasEffectType) {
    effectType = normalizeEffectType(effectTypeInput)
    if (!effectType) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectType is invalid' }
  }

  if (effectiveFromField.present && !effectiveFromField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date or null' }
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_versions', id)
    const existing = await findRuleVersionWithOrganization(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_version.metadata')
    if (terminalVerificationStatuses.includes(existing.verificationStatus))
      return {
        kind: 'terminal' as const,
        message: 'rule version is VERIFIED or REJECTED and cannot be changed; create a new rule version instead',
      }

    const nextEffectiveFrom = effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value : existing.effectiveFrom
    const nextEffectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : existing.effectiveTo
    if (nextEffectiveFrom && nextEffectiveTo && nextEffectiveFrom.getTime() > nextEffectiveTo.getTime())
      return { kind: 'terminal' as const, message: 'effectiveFrom must not be after effectiveTo' }

    const record = await updateRuleVersionRecord(
      id,
      {
        ...(effectType ? { effectType } : {}),
        ...(effectiveFromField.present && effectiveFromField.valid ? { effectiveFrom: effectiveFromField.value } : {}),
        ...(effectiveToField.present && effectiveToField.valid ? { effectiveTo: effectiveToField.value } : {}),
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: existing.rule.organizationId as string,
        actorUserId,
        actionCode: 'rule_version.updated',
        entityType: 'RULE_VERSION',
        entityId: id,
        beforeState: ruleVersionAuditSnapshot(existing),
        afterState: ruleVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function updateRuleVersionVerification(
  id: string,
  verificationStatusInput: unknown,
  actorUserId: string,
): Promise<RuleVersionResult<RuleVersionDto>> {
  if (!isRuleVersionUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  if (!isSourceVerificationStatus(verificationStatusInput) || verificationStatusInput === 'UNVERIFIED')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'verificationStatus must be IN_REVIEW, VERIFIED, or REJECTED' }
  const nextStatus = verificationStatusInput

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_versions', id)
    const existing = await findRuleVersionWithOrganization(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_version.verification')
    if (terminalVerificationStatuses.includes(existing.verificationStatus))
      return { kind: 'terminal' as const, message: 'rule version verification is already VERIFIED or REJECTED and cannot be changed' }

    // verifiedAt is server-generated: non-null only the moment status becomes VERIFIED,
    // and never client-suppliable. Verified != executable — no activation side effect here.
    const verifiedAt = nextStatus === 'VERIFIED' ? new Date() : null
    const record = await updateRuleVersionRecord(id, { verificationStatus: nextStatus, verifiedAt }, tx)

    await recordAuditEvent(
      {
        organizationId: existing.rule.organizationId as string,
        actorUserId,
        actionCode: 'rule_version.verification_updated',
        entityType: 'RULE_VERSION',
        entityId: id,
        beforeState: ruleVersionAuditSnapshot(existing),
        afterState: ruleVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}
