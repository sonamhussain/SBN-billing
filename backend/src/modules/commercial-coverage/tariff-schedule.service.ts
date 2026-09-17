import { findProviderContractById } from './provider-contract.repository.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { TariffScheduleDto, TariffScheduleResult, TariffScheduleVersionDto } from './tariff-schedule.types.ts'
import { isCommercialContextUuid, normalizeCommercialDisplayName, normalizeCommercialKey } from './commercial-context.validation.ts'
import {
  isSourceVerificationStatus,
  normalizeDateOnlyField,
  normalizeVersion,
  formatDateOnly,
} from '../rule-source-version/rule-source-version.validation.ts'
import {
  createTariffScheduleRecord,
  createTariffScheduleVersionRecord,
  findTariffScheduleById,
  findTariffScheduleVersionById,
  findTariffScheduleVersionsByScheduleId,
  findTariffSchedulesByContractId,
  updateTariffScheduleDisplayName,
  updateTariffScheduleVersionRecord,
} from './tariff-schedule.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { tariffScheduleAuditSnapshot, tariffScheduleVersionAuditSnapshot } from '../audit/audit.snapshot.ts'

type TariffScheduleRecord = {
  id: string
  providerContractId: string
  tariffKey: string
  displayName: string
  createdAt: Date
  updatedAt: Date
}

type TariffScheduleVersionRecord = {
  id: string
  tariffScheduleId: string
  version: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const terminalVerificationStatuses: readonly string[] = ['VERIFIED', 'REJECTED']

function toDto(record: TariffScheduleRecord): TariffScheduleDto {
  return {
    id: record.id,
    providerContractId: record.providerContractId,
    tariffKey: record.tariffKey,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toVersionDto(record: TariffScheduleVersionRecord): TariffScheduleVersionDto {
  return {
    id: record.id,
    tariffScheduleId: record.tariffScheduleId,
    version: record.version,
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

export async function createTariffSchedule(
  providerContractId: string,
  tariffKeyInput: unknown,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<TariffScheduleResult<TariffScheduleDto>> {
  if (!isCommercialContextUuid(providerContractId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid provider contract id' }

  const tariffKey = normalizeCommercialKey(tariffKeyInput)
  if (!tariffKey) return { ok: false, code: 'VALIDATION_ERROR', message: 'tariffKey is required' }

  const displayName = normalizeCommercialDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const contract = await findProviderContractById(providerContractId)
  if (!contract) return { ok: false, code: 'NOT_FOUND', message: 'provider contract not found' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createTariffScheduleRecord({ providerContractId, tariffKey, displayName }, tx)

      await recordAuditEvent(
        {
          organizationId: contract.organizationId,
          actorUserId,
          actionCode: 'tariff_schedule.created',
          entityType: 'TARIFF_SCHEDULE',
          entityId: record.id,
          beforeState: null,
          afterState: tariffScheduleAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'tariffKey already exists for this provider contract' }
    throw error
  }
}

export async function getTariffSchedule(id: string): Promise<TariffScheduleResult<TariffScheduleDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule id' }
  const record = await findTariffScheduleById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule not found' }
  return { ok: true, value: toDto(record) }
}

export async function listTariffSchedules(providerContractId: string): Promise<TariffScheduleResult<TariffScheduleDto[]>> {
  if (!isCommercialContextUuid(providerContractId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid provider contract id' }

  const contract = await findProviderContractById(providerContractId)
  if (!contract) return { ok: false, code: 'NOT_FOUND', message: 'provider contract not found' }

  const records = await findTariffSchedulesByContractId(providerContractId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateTariffSchedule(
  id: string,
  displayNameInput: unknown,
  actorUserId: string,
): Promise<TariffScheduleResult<TariffScheduleDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule id' }
  const displayName = normalizeCommercialDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findTariffScheduleById(id, tx)
    if (!existing) return null

    const contract = await findProviderContractById(existing.providerContractId, tx)
    const record = await updateTariffScheduleDisplayName(id, displayName, tx)

    await recordAuditEvent(
      {
        organizationId: contract?.organizationId as string,
        actorUserId,
        actionCode: 'tariff_schedule.updated',
        entityType: 'TARIFF_SCHEDULE',
        entityId: id,
        beforeState: tariffScheduleAuditSnapshot(existing),
        afterState: tariffScheduleAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule not found' }
  return { ok: true, value: toDto(updated) }
}

export async function createTariffScheduleVersion(
  tariffScheduleId: string,
  versionInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
): Promise<TariffScheduleResult<TariffScheduleVersionDto>> {
  if (!isCommercialContextUuid(tariffScheduleId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule id' }

  const version = normalizeVersion(versionInput)
  if (!version) return { ok: false, code: 'VALIDATION_ERROR', message: 'version is required' }

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

  const schedule = await findTariffScheduleById(tariffScheduleId)
  if (!schedule) return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule not found' }

  const contract = await findProviderContractById(schedule.providerContractId)

  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await createTariffScheduleVersionRecord({ tariffScheduleId, version, effectiveFrom, effectiveTo }, tx)

      await recordAuditEvent(
        {
          organizationId: contract?.organizationId as string,
          actorUserId,
          actionCode: 'tariff_schedule_version.created',
          entityType: 'TARIFF_SCHEDULE_VERSION',
          entityId: record.id,
          beforeState: null,
          afterState: tariffScheduleVersionAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toVersionDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'version already exists for this tariff schedule' }
    throw error
  }
}

export async function getTariffScheduleVersion(id: string): Promise<TariffScheduleResult<TariffScheduleVersionDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule version id' }
  const record = await findTariffScheduleVersionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule version not found' }
  return { ok: true, value: toVersionDto(record) }
}

export async function listTariffScheduleVersions(
  tariffScheduleId: string,
): Promise<TariffScheduleResult<TariffScheduleVersionDto[]>> {
  if (!isCommercialContextUuid(tariffScheduleId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule id' }

  const schedule = await findTariffScheduleById(tariffScheduleId)
  if (!schedule) return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule not found' }

  const records = await findTariffScheduleVersionsByScheduleId(tariffScheduleId)
  return { ok: true, value: records.map(toVersionDto) }
}

async function organizationIdForVersion(scheduleId: string, tx: DbClient) {
  const schedule = await findTariffScheduleById(scheduleId, tx)
  if (!schedule) return null
  const contract = await findProviderContractById(schedule.providerContractId, tx)
  return contract?.organizationId ?? null
}

export async function updateTariffScheduleVersionMetadata(
  id: string,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
): Promise<TariffScheduleResult<TariffScheduleVersionDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule version id' }

  const effectiveFromField = normalizeDateOnlyField(effectiveFromInput)
  const effectiveToField = normalizeDateOnlyField(effectiveToInput)
  if (effectiveFromField.present && !effectiveFromField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date or null' }
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }
  if (!effectiveFromField.present && !effectiveToField.present)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'tariff_schedule_versions', id)
    const existing = await findTariffScheduleVersionById(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('tariff_schedule_version.metadata')
    if (terminalVerificationStatuses.includes(existing.verificationStatus))
      return {
        kind: 'terminal' as const,
        message: 'tariff schedule version is VERIFIED or REJECTED and cannot be changed; create a new version instead',
      }

    const nextEffectiveFrom = effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value : existing.effectiveFrom
    const nextEffectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : existing.effectiveTo
    if (nextEffectiveFrom && nextEffectiveTo && nextEffectiveFrom.getTime() > nextEffectiveTo.getTime())
      return { kind: 'terminal' as const, message: 'effectiveFrom must not be after effectiveTo' }

    const record = await updateTariffScheduleVersionRecord(
      id,
      {
        ...(effectiveFromField.present && effectiveFromField.valid ? { effectiveFrom: effectiveFromField.value } : {}),
        ...(effectiveToField.present && effectiveToField.valid ? { effectiveTo: effectiveToField.value } : {}),
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: (await organizationIdForVersion(existing.tariffScheduleId, tx)) as string,
        actorUserId,
        actionCode: 'tariff_schedule_version.lifecycle_updated',
        entityType: 'TARIFF_SCHEDULE_VERSION',
        entityId: id,
        beforeState: tariffScheduleVersionAuditSnapshot(existing),
        afterState: tariffScheduleVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toVersionDto(outcome.record) }
}

export async function updateTariffScheduleVersionVerification(
  id: string,
  verificationStatusInput: unknown,
  actorUserId: string,
): Promise<TariffScheduleResult<TariffScheduleVersionDto>> {
  if (!isCommercialContextUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule version id' }

  if (!isSourceVerificationStatus(verificationStatusInput) || verificationStatusInput === 'UNVERIFIED')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'verificationStatus must be IN_REVIEW, VERIFIED, or REJECTED' }
  const nextStatus = verificationStatusInput

  const outcome = await prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'tariff_schedule_versions', id)
    const existing = await findTariffScheduleVersionById(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe('tariff_schedule_version.verification')
    if (terminalVerificationStatuses.includes(existing.verificationStatus))
      return { kind: 'terminal' as const, message: 'tariff schedule version verification is already VERIFIED or REJECTED and cannot be changed' }

    const verifiedAt = nextStatus === 'VERIFIED' ? new Date() : null
    const record = await updateTariffScheduleVersionRecord(id, { verificationStatus: nextStatus, verifiedAt }, tx)

    await recordAuditEvent(
      {
        organizationId: (await organizationIdForVersion(existing.tariffScheduleId, tx)) as string,
        actorUserId,
        actionCode: 'tariff_schedule_version.verification_updated',
        entityType: 'TARIFF_SCHEDULE_VERSION',
        entityId: id,
        beforeState: tariffScheduleVersionAuditSnapshot(existing),
        afterState: tariffScheduleVersionAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule version not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toVersionDto(outcome.record) }
}
