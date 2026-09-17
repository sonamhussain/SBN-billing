import { findRuleSourceById } from '../rule-source/rule-source.repository.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import type { ActivationEvaluationDto, RuleSourceVersionDto, RuleSourceVersionResult } from './rule-source-version.types.ts'
import {
  isRuleSourceVersionUuid,
  isSourceVerificationStatus,
  normalizeBusinessDate,
  normalizeContextJurisdictionCode,
  normalizeDateOnlyField,
  normalizeRawEvidenceRef,
  normalizeVersion,
  formatDateOnly,
  areEffectiveDatesFrozen,
} from './rule-source-version.validation.ts'
import { evaluateActivationBlockers } from './rule-source-version.activation.ts'
import {
  createRuleSourceVersionRecord,
  findRuleSourceVersionById,
  findRuleSourceVersionForActivation,
  findRuleSourceVersionsBySourceId,
  updateRuleSourceVersionLifecycle,
} from './rule-source-version.repository.ts'
import { findOutgoingSupersedesTargets } from '../rule-source-relationship/rule-source-relationship.repository.ts'
import { computeActivationRelationshipSignals } from '../rule-source-relationship/rule-source-relationship.service.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleSourceVersionAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleSourceVersionRecord = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  publicationStatus: string
  publicationDate: Date | null
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
  activationStatus: string
  activationBlockers: string[]
  activatedAt: Date | null
  suspendedAt: Date | null
  supersededAt: Date | null
  retiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toDto(record: RuleSourceVersionRecord): RuleSourceVersionDto {
  return {
    id: record.id,
    sourceId: record.sourceId,
    version: record.version,
    rawEvidenceRef: record.rawEvidenceRef,
    publicationStatus: record.publicationStatus,
    publicationDate: formatDateOnly(record.publicationDate),
    effectiveFrom: formatDateOnly(record.effectiveFrom),
    effectiveTo: formatDateOnly(record.effectiveTo),
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt ? record.verifiedAt.toISOString() : null,
    activationStatus: record.activationStatus,
    activationBlockers: record.activationBlockers,
    activatedAt: record.activatedAt ? record.activatedAt.toISOString() : null,
    suspendedAt: record.suspendedAt ? record.suspendedAt.toISOString() : null,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    retiredAt: record.retiredAt ? record.retiredAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}


// A3.4 safe supersession transition: only runs after FROM successfully becomes ACTIVE, inside
// the same transaction. Targets already SUPERSEDED or RETIRED are left untouched (historical
// preservation) — idempotent-safe, never overwrites an existing supersededAt/retiredAt.
async function supersedeDirectTargets(
  fromVersionId: string,
  actorUserId: string,
  fallbackOrganizationId: string,
  tx: DbClient,
): Promise<void> {
  const targets = await findOutgoingSupersedesTargets(fromVersionId, tx)
  for (const { toSourceVersionId } of targets) {
    // Audit F08: the superseded target is a governed row too — lock it before reading its state.
    await lockRowForUpdate(tx, 'rule_source_versions', toSourceVersionId)
    const target = await findRuleSourceVersionForActivation(toSourceVersionId, tx)
    if (!target) continue
    if (target.activationStatus === 'SUPERSEDED' || target.activationStatus === 'RETIRED') continue

    const updated = await updateRuleSourceVersionLifecycle(
      toSourceVersionId,
      { activationStatus: 'SUPERSEDED', supersededAt: new Date() },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: (target.source.organizationId ?? fallbackOrganizationId) as string,
        actorUserId,
        actionCode: 'rule_source_version.superseded',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: toSourceVersionId,
        beforeState: ruleSourceVersionAuditSnapshot(target),
        afterState: ruleSourceVersionAuditSnapshot(updated),
      },
      tx,
    )
  }
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

// A3.3 lifecycle & activation control

export async function updateLifecycleMetadata(
  id: string,
  publicationDateInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const publicationDateField = normalizeDateOnlyField(publicationDateInput)
  const effectiveFromField = normalizeDateOnlyField(effectiveFromInput)
  const effectiveToField = normalizeDateOnlyField(effectiveToInput)

  if (publicationDateField.present && !publicationDateField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'publicationDate must be a YYYY-MM-DD date or null' }
  if (effectiveFromField.present && !effectiveFromField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date or null' }
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }

  if (!publicationDateField.present && !effectiveFromField.present && !effectiveToField.present)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.metadata')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is retired and cannot be changed' }

    if (publicationDateField.present && existing.publicationStatus === 'PUBLISHED')
      return { kind: 'terminal' as const, message: 'publicationDate is immutable once published' }

    if ((effectiveFromField.present || effectiveToField.present) && areEffectiveDatesFrozen(existing.activationStatus, existing.everActivated))
      return {
        kind: 'terminal' as const,
        message: 'effective dates are immutable once activated; create a new source version instead',
      }

    const nextEffectiveFrom = effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value : existing.effectiveFrom
    const nextEffectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : existing.effectiveTo
    if (nextEffectiveFrom && nextEffectiveTo && nextEffectiveFrom.getTime() > nextEffectiveTo.getTime())
      return { kind: 'terminal' as const, message: 'effectiveFrom must not be after effectiveTo' }

    const record = await updateRuleSourceVersionLifecycle(
      id,
      {
        ...(publicationDateField.present && publicationDateField.valid ? { publicationDate: publicationDateField.value } : {}),
        ...(effectiveFromField.present && effectiveFromField.valid ? { effectiveFrom: effectiveFromField.value } : {}),
        ...(effectiveToField.present && effectiveToField.valid ? { effectiveTo: effectiveToField.value } : {}),
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: 'rule_source_version.lifecycle_updated',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function publishRuleSourceVersion(
  id: string,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.publish')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is retired and cannot be changed' }
    if (existing.publicationStatus !== 'DRAFT')
      return { kind: 'terminal' as const, message: 'only a DRAFT source version can be published' }
    if (!existing.publicationDate)
      return { kind: 'terminal' as const, message: 'publicationDate must be set before publishing' }

    // Publication never touches activationStatus — publish != activate.
    const record = await updateRuleSourceVersionLifecycle(id, { publicationStatus: 'PUBLISHED' }, tx)

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: 'rule_source_version.published',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function updateSourceVerification(
  id: string,
  verificationStatusInput: unknown,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  if (!isSourceVerificationStatus(verificationStatusInput) || verificationStatusInput === 'UNVERIFIED')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'verificationStatus must be IN_REVIEW, VERIFIED, or REJECTED' }
  const nextStatus = verificationStatusInput

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.verification')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is retired and cannot be changed' }
    if (existing.verificationStatus === 'VERIFIED' || existing.verificationStatus === 'REJECTED')
      return { kind: 'terminal' as const, message: 'source verification is already VERIFIED or REJECTED and cannot be changed' }

    // Activation never auto-follows source verification — verified != active.
    const verifiedAt = nextStatus === 'VERIFIED' ? new Date() : null
    const record = await updateRuleSourceVersionLifecycle(id, { verificationStatus: nextStatus, verifiedAt }, tx)

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: 'rule_source_version.verification_updated',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function evaluateRuleSourceVersionActivation(
  id: string,
  businessDateInput: unknown,
  jurisdictionCodeInput: unknown,
): Promise<RuleSourceVersionResult<ActivationEvaluationDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const businessDate = normalizeBusinessDate(businessDateInput)
  if (!businessDate) return { ok: false, code: 'VALIDATION_ERROR', message: 'businessDate must be a YYYY-MM-DD date' }

  const jurisdictionCode = normalizeContextJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  // Non-mutating preview: plain read, no transaction, no audit event.
  const existing = await findRuleSourceVersionForActivation(id)
  if (!existing) return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }

  const relationshipSignals = await computeActivationRelationshipSignals(id)

  const blockers = evaluateActivationBlockers(
    existing,
    existing.source,
    existing.interpretations,
    { businessDate, jurisdictionCode, requestingOrganizationId: existing.source.organizationId },
    relationshipSignals,
  )

  return { ok: true, value: { blockers } }
}

export async function activateRuleSourceVersion(
  id: string,
  businessDateInput: unknown,
  jurisdictionCodeInput: unknown,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const businessDate = normalizeBusinessDate(businessDateInput)
  if (!businessDate) return { ok: false, code: 'VALIDATION_ERROR', message: 'businessDate must be a YYYY-MM-DD date' }

  const jurisdictionCode = normalizeContextJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.activate')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is retired and cannot be changed' }
    if (existing.activationStatus !== 'INACTIVE' && existing.activationStatus !== 'BLOCKED')
      return { kind: 'terminal' as const, message: 'activate is only allowed from INACTIVE or BLOCKED' }

    const relationshipSignals = await computeActivationRelationshipSignals(id, tx)

    const blockers = evaluateActivationBlockers(
      existing,
      existing.source,
      existing.interpretations,
      { businessDate, jurisdictionCode, requestingOrganizationId: existing.source.organizationId },
      relationshipSignals,
    )

    const becameActive = blockers.length === 0
    const record = await updateRuleSourceVersionLifecycle(
      id,
      becameActive
        ? {
            activationStatus: 'ACTIVE',
            activatedAt: new Date(),
            activationBlockers: [],
            // Audit F09: set once, never cleared — a later failed resume keeps both.
            everActivated: true,
            firstActivatedAt: existing.firstActivatedAt ?? new Date(),
          }
        : { activationStatus: 'BLOCKED', activatedAt: null, activationBlockers: blockers },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: becameActive ? 'rule_source_version.activated' : 'rule_source_version.activation_blocked',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    if (becameActive) {
      await supersedeDirectTargets(id, actorUserId, existing.source.organizationId as string, tx)
    }

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function suspendRuleSourceVersion(
  id: string,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.suspend')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is retired and cannot be changed' }
    if (existing.activationStatus !== 'ACTIVE')
      return { kind: 'terminal' as const, message: 'suspend is only allowed from ACTIVE' }

    const record = await updateRuleSourceVersionLifecycle(id, { activationStatus: 'SUSPENDED', suspendedAt: new Date() }, tx)

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: 'rule_source_version.suspended',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function resumeRuleSourceVersion(
  id: string,
  businessDateInput: unknown,
  jurisdictionCodeInput: unknown,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const businessDate = normalizeBusinessDate(businessDateInput)
  if (!businessDate) return { ok: false, code: 'VALIDATION_ERROR', message: 'businessDate must be a YYYY-MM-DD date' }

  const jurisdictionCode = normalizeContextJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.resume')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is retired and cannot be changed' }
    if (existing.activationStatus !== 'SUSPENDED')
      return { kind: 'terminal' as const, message: 'resume is only allowed from SUSPENDED' }

    const relationshipSignals = await computeActivationRelationshipSignals(id, tx)

    const blockers = evaluateActivationBlockers(
      existing,
      existing.source,
      existing.interpretations,
      { businessDate, jurisdictionCode, requestingOrganizationId: existing.source.organizationId },
      relationshipSignals,
    )

    const becameActive = blockers.length === 0
    const record = await updateRuleSourceVersionLifecycle(
      id,
      becameActive
        ? {
            activationStatus: 'ACTIVE',
            activatedAt: new Date(),
            activationBlockers: [],
            // Audit F09: set once, never cleared — a later failed resume keeps both.
            everActivated: true,
            firstActivatedAt: existing.firstActivatedAt ?? new Date(),
          }
        : { activationStatus: 'BLOCKED', activatedAt: null, activationBlockers: blockers },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: 'rule_source_version.resumed',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    if (becameActive) {
      await supersedeDirectTargets(id, actorUserId, existing.source.organizationId as string, tx)
    }

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function retireRuleSourceVersion(
  id: string,
  actorUserId: string,
): Promise<RuleSourceVersionResult<RuleSourceVersionDto>> {
  if (!isRuleSourceVersionUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'rule_source_versions', id)
    const existing = await findRuleSourceVersionForActivation(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('rule_source_version.retire')
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'source version is already retired' }
    if (existing.activationStatus === 'SUPERSEDED')
      return { kind: 'terminal' as const, message: 'superseded source versions cannot be retired through this API' }

    const record = await updateRuleSourceVersionLifecycle(id, { activationStatus: 'RETIRED', retiredAt: new Date() }, tx)

    await recordAuditEvent(
      {
        organizationId: existing.source.organizationId as string,
        actorUserId,
        actionCode: 'rule_source_version.retired',
        entityType: 'RULE_SOURCE_VERSION',
        entityId: id,
        beforeState: ruleSourceVersionAuditSnapshot(existing),
        afterState: ruleSourceVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}
