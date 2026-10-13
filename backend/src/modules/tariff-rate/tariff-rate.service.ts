import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import {
  createTariffRateRecord,
  findActiveRateWithIdentity,
  findProcedureCodeOrganization,
  findServiceOrganization,
  findTariffRateById,
  findTariffRatesOfVersion,
  findTariffVersionScope,
  markTariffRateRetired,
} from './tariff-rate.repository.ts'
import { RATE_CONTRACT_VERSION, type TariffRateDto, type TariffRateErrorCode, type TariffRateResult } from './tariff-rate.types.ts'
import { isTariffRateUuid, validateCreateRateBody, validateRetireBody } from './tariff-rate.validation.ts'

// A6.3 §8 — rate writes. Every writer locks the parent TariffScheduleVersion FOR UPDATE, the same row the
// REF-01 verification writer locks, and decides on reads taken after the lock. A rate can therefore never
// be written into a version while it is being verified, and a pricing run (which holds that row FOR
// SHARE) never reads a rate set that is changing. Lock order for every A6.3 writer: Claim -> tariff
// version -> rates.

class RateRefusal extends Error {
  readonly code: TariffRateErrorCode
  constructor(code: TariffRateErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: TariffRateErrorCode, message: string): never {
  throw new RateRefusal(code, message)
}

type RateRecord = NonNullable<Awaited<ReturnType<typeof findTariffRateById>>>

function toTariffRateDto(record: RateRecord): TariffRateDto {
  return {
    id: record.id,
    tariffScheduleVersionId: record.tariffScheduleVersionId,
    selectorKind: record.selectorKind,
    serviceId: record.serviceId,
    procedureCodeId: record.procedureCodeId,
    unitCodeKey: record.unitCodeKey,
    modifierCodes: record.modifierSignature,
    currencyCode: record.currencyCode,
    unitTariffAmount: record.unitTariffAmount.toFixed(4),
    rateContractVersion: record.rateContractVersion,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

// §11 — what changed, under which contract and when; never the fee amount, currency or rated identity.
const rateAuditSnapshot = (record: RateRecord) => ({
  id: record.id,
  tariffScheduleVersionId: record.tariffScheduleVersionId,
  rateContractVersion: record.rateContractVersion,
  createdAt: record.createdAt.toISOString(),
  removedAt: record.removedAt ? record.removedAt.toISOString() : null,
})

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
const isRateLocked = (error: unknown) => error instanceof Error && error.message.includes('rate_version_locked')

async function inRateTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<TariffRateResult<T>> {
  try {
    return { ok: true, value: await prisma.$transaction(work) }
  } catch (error) {
    if (error instanceof RateRefusal) return { ok: false, code: error.code, message: error.message }
    if (isUniqueViolation(error)) return { ok: false, code: 'RATE_DUPLICATE', message: 'an active rate with this exact identity already exists in this tariff version' }
    if (isRateLocked(error)) return { ok: false, code: 'RATE_VERSION_LOCKED', message: 'rates can be changed only while the tariff version is UNVERIFIED' }
    throw error
  }
}

// ---- create (§8.1–§8.3) --------------------------------------------------------------------------

export async function createTariffRate(versionId: string, body: unknown, actorUserId: string): Promise<TariffRateResult<TariffRateDto>> {
  if (!isTariffRateUuid(versionId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule version id' }
  const validated = validateCreateRateBody(body)
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }
  const input = validated.value

  return inRateTransaction(async (tx) => {
    if (!(await lockRowForUpdate(tx, 'tariff_schedule_versions', versionId))) refuse('NOT_FOUND', 'tariff schedule version not found')
    await concurrencyProbe('tariffRate.version_locked')
    const version = await findTariffVersionScope(versionId, tx)
    if (!version) return refuse('NOT_FOUND', 'tariff schedule version not found')
    if (version.verificationStatus !== 'UNVERIFIED') refuse('RATE_VERSION_LOCKED', 'rates can be created only while the tariff version is UNVERIFIED')

    // A missing and a foreign master are refused identically, so nothing about another organization leaks.
    const master = input.serviceId ? await findServiceOrganization(input.serviceId, tx) : await findProcedureCodeOrganization(input.procedureCodeId as string, tx)
    if (!master || master.organizationId !== version.organizationId) refuse('NOT_FOUND', input.serviceId ? 'service not found' : 'procedure code not found')

    const identity = { tariffScheduleVersionId: versionId, ...input }
    if (await findActiveRateWithIdentity(identity, tx)) refuse('RATE_DUPLICATE', 'an active rate with this exact identity already exists in this tariff version')

    const record = await createTariffRateRecord(
      {
        tariffScheduleVersionId: versionId,
        selectorKind: input.selectorKind,
        serviceId: input.serviceId,
        procedureCodeId: input.procedureCodeId,
        unitCodeKey: input.unitCodeKey,
        modifierSignature: input.modifierSignature,
        currencyCode: input.currencyCode,
        unitTariffAmount: new Prisma.Decimal(input.unitTariffAmount),
        rateContractVersion: RATE_CONTRACT_VERSION,
        createdByUserId: actorUserId,
      },
      tx,
    )
    await recordAuditEvent(
      { organizationId: version.organizationId, actorUserId, actionCode: 'tariff_rate.created', entityType: 'TARIFF_RATE', entityId: record.id, beforeState: null, afterState: rateAuditSnapshot(record) },
      tx,
    )
    await concurrencyProbe('tariffRate.created')
    return toTariffRateDto(record)
  })
}

// ---- list (§9) -----------------------------------------------------------------------------------

export async function listTariffRates(versionId: string): Promise<TariffRateResult<{ items: TariffRateDto[] }>> {
  if (!isTariffRateUuid(versionId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff schedule version id' }
  if (!(await findTariffVersionScope(versionId))) return { ok: false, code: 'NOT_FOUND', message: 'tariff schedule version not found' }
  return { ok: true, value: { items: (await findTariffRatesOfVersion(versionId)).map(toTariffRateDto) } }
}

// ---- retire (§8.4) -------------------------------------------------------------------------------

export async function retireTariffRate(rateId: string, body: unknown, actorUserId: string): Promise<TariffRateResult<TariffRateDto>> {
  if (!isTariffRateUuid(rateId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid tariff rate id' }
  const validated = validateRetireBody(body)
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }

  return inRateTransaction(async (tx) => {
    // The rate's version never changes, so this unlocked read only finds the lock target.
    const located = await findTariffRateById(rateId, tx)
    if (!located) return refuse('NOT_FOUND', 'tariff rate not found')
    await lockRowForUpdate(tx, 'tariff_schedule_versions', located.tariffScheduleVersionId)
    const version = await findTariffVersionScope(located.tariffScheduleVersionId, tx)
    const current = await findTariffRateById(rateId, tx)
    if (!version || !current) return refuse('NOT_FOUND', 'tariff rate not found')
    if (current.removedAt !== null) refuse('RATE_ALREADY_RETIRED', 'this tariff rate is already retired')
    if (version.verificationStatus !== 'UNVERIFIED') refuse('RATE_VERSION_LOCKED', 'rates can be retired only while the tariff version is UNVERIFIED')

    const retired = await markTariffRateRetired(rateId, tx)
    await recordAuditEvent(
      {
        organizationId: version.organizationId,
        actorUserId,
        actionCode: 'tariff_rate.retired',
        entityType: 'TARIFF_RATE',
        entityId: rateId,
        beforeState: { id: rateId, removedAt: null },
        afterState: { id: rateId, removedAt: retired.removedAt ? retired.removedAt.toISOString() : null },
      },
      tx,
    )
    return toTariffRateDto(retired)
  })
}
