import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForShare } from '../../shared/database/row-lock.ts'
import { isEffectiveOn } from '../../shared/rules/date-only.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { findClaimForStructure } from '../claim-line/claim-line.repository.ts'
// A6.2 owns the Claim structure gate: the Claim lock plus the A5.9 transaction-aware handoff composer on
// this transaction's own snapshot. A6.3 reuses it and never re-implements readiness or recency.
import { ClaimStructureRefusal, openClaimStructureGate } from '../claim-line/claim-line.service.ts'
import { checkActiveOrder, isClaimStructureUuid } from '../claim-line/claim-line.validation.ts'
import { evaluateLine, evaluateRun, lineFingerprint, moneyText, runFingerprint, type RateCandidate, type SourceFacts } from './claim-pricing.calculator.ts'
import {
  createPricingLineResults,
  createPricingRunRecord,
  findActiveLinesWithSources,
  findActiveRatesOfVersion,
  findBoundCommercialLineage,
  findPricingRunById,
  findPricingRunsOfClaim,
  findTariffVersionLineage,
} from './claim-pricing.repository.ts'
import {
  PRICING_CONTRACT_VERSION,
  type ClaimPricingErrorCode,
  type ClaimPricingResult,
  type PricingLineDto,
  type PricingRunDto,
  type PricingRunListDto,
  type PricingRunSummaryDto,
} from './claim-pricing.types.ts'
import { validateCreatePricingRunBody } from './claim-pricing.validation.ts'

// A6.3 §7 — one pricing run per request, in one SERIALIZABLE read-write transaction with bounded retry:
// 1. lock the Claim and run the A5.9 handoff composer (the A6.2 gate) — superseded, tied, incompatible or
//    non-READY bases are refused;
// 2. read the exact commercial lineage of the bound ValidationRun and prove it coherent, VERIFIED and
//    effective on the captured service date — nothing is re-resolved against today's data;
// 3. lock the bound tariff version FOR SHARE, so no rate write or verification can overtake this run;
// 4. read the active lines and their exact sources, refusing corrupt structure without repairing it;
// 5. evaluate every line with Decimal and persist the run, its line results and one audit atomically.

class PricingRefusal extends Error {
  readonly code: ClaimPricingErrorCode
  constructor(code: ClaimPricingErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClaimPricingErrorCode, message: string): never {
  throw new PricingRefusal(code, message)
}

const unresolved = (message: string): never => refuse('PRICING_COMMERCIAL_CONTEXT_UNRESOLVED', message)

const MAX_PRICING_ATTEMPTS = 3

const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The database guards are the backstop behind every service check; their refusals keep the contract codes.
const databaseGuardCodes: [string, ClaimPricingErrorCode][] = [
  ['pricing_commercial_context_unresolved', 'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED'],
  ['pricing_source_integrity', 'PRICING_SOURCE_INTEGRITY'],
]

async function runPricingWrite<T>(work: (tx: DbClient) => Promise<T>): Promise<ClaimPricingResult<T>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await prisma.$transaction((tx) => work(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000 })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof PricingRefusal || error instanceof ClaimStructureRefusal) return { ok: false, code: error.code, message: error.message }
      if (isWriteConflict(error)) {
        if (attempt < MAX_PRICING_ATTEMPTS) continue
        return { ok: false, code: 'PRICING_CONFLICT', message: 'concurrent changes kept conflicting with this pricing run; nothing was written' }
      }
      const guard = error instanceof Error ? databaseGuardCodes.find(([marker]) => error.message.includes(marker)) : undefined
      if (guard) return { ok: false, code: guard[1], message: 'the database refused the pricing run; nothing was written' }
      throw error
    }
  }
}

// ---- DTOs ----------------------------------------------------------------------------------------

type RunRecord = NonNullable<Awaited<ReturnType<typeof findPricingRunById>>>
type RunSummaryRecord = Omit<RunRecord, 'lineResults'>

function toSummaryDto(record: RunSummaryRecord): PricingRunSummaryDto {
  return {
    id: record.id,
    claimId: record.claimId,
    pricingContractVersion: record.pricingContractVersion,
    tariffScheduleVersionId: record.tariffScheduleVersionId,
    providerContractId: record.providerContractId,
    tariffScheduleId: record.tariffScheduleId,
    evaluatedAt: record.evaluatedAt.toISOString(),
    overallResult: record.overallResult,
    lineCount: record.lineCount,
    pricedCount: record.pricedCount,
    currencyCode: record.currencyCode,
    totalExtendedTariffAmount: record.overallResult === 'PRICED' ? moneyText(record.totalExtendedAmount, record.currencyCode) : null,
    inputStructureFingerprint: record.inputStructureFingerprint,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

function toRunDto(record: RunRecord): PricingRunDto {
  return {
    ...toSummaryDto(record),
    lines: record.lineResults.map(
      (line): PricingLineDto => ({
        claimLineId: line.claimLineId,
        encounterActivityId: line.encounterActivityId,
        lineSequenceAtEvaluation: line.lineSequenceAtEvaluation,
        outcome: line.outcome,
        tariffRateId: line.tariffRateId,
        unitTariffAmount: line.unitTariffAmount ? line.unitTariffAmount.toFixed(4) : null,
        quantityAtEvaluation: line.quantityAtEvaluation.toFixed(4),
        extendedTariffAmount: moneyText(line.extendedAmount, line.currencyCode),
        currencyCode: line.currencyCode,
        inputFingerprint: line.inputFingerprint,
      }),
    ),
  }
}

// ---- create (§7) ---------------------------------------------------------------------------------

export async function createPricingRun(claimId: string, body: unknown, actorUserId: string): Promise<ClaimPricingResult<PricingRunDto>> {
  if (!isClaimStructureUuid(claimId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid claim id' }
  const validated = validateCreatePricingRunBody(body)
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }

  return runPricingWrite(async (tx) => {
    const gate = await openClaimStructureGate(claimId, 'claimPricing.create', tx)

    const lineage = await findBoundCommercialLineage(claimId, tx)
    if (!lineage) return refuse('NOT_FOUND', 'claim not found')
    const { providerContractId, tariffScheduleId, tariffScheduleVersionId, serviceDate } = lineage
    if (!providerContractId || !tariffScheduleId || !tariffScheduleVersionId) return unresolved('the bound validation run has no complete commercial lineage to price against')

    if (!(await lockRowForShare(tx, 'tariff_schedule_versions', tariffScheduleVersionId))) return unresolved('the bound tariff version no longer exists')
    await concurrencyProbe('claimPricing.version_locked')
    const version = await findTariffVersionLineage(tariffScheduleVersionId, tx)
    if (!version || version.tariffScheduleId !== tariffScheduleId || version.tariffSchedule.providerContractId !== providerContractId)
      return unresolved('the bound contract, schedule and version are not coherent')
    if (version.verificationStatus !== 'VERIFIED') return unresolved('the bound tariff version is not VERIFIED')
    if (!isEffectiveOn(version.effectiveFrom, version.effectiveTo, serviceDate)) return unresolved('the bound tariff version is not provably effective on the service date')

    const lines = await findActiveLinesWithSources(claimId, tx)
    const order = checkActiveOrder(lines)
    if (!order.ok) refuse('PRICING_SOURCE_INTEGRITY', order.message)
    const sources: SourceFacts[] = lines.map((line) => {
      if (line.sources.length !== 1) refuse('PRICING_SOURCE_INTEGRITY', 'a claim line does not have exactly one source activity')
      const activity = line.sources[0].encounterActivity
      if (activity.encounterId !== gate.encounterId) refuse('PRICING_SOURCE_INTEGRITY', 'a claim line source belongs to another encounter')
      return {
        claimLineId: line.id,
        sequence: line.sequence,
        encounterActivityId: activity.id,
        serviceId: activity.serviceId,
        procedureCodeId: activity.procedureCodeId,
        quantity: activity.quantity,
        unitCode: activity.unitCode,
        modifierCodes: activity.modifiers.map((modifier) => modifier.code),
        removed: activity.removedAt !== null,
      }
    })

    const rates: RateCandidate[] = await findActiveRatesOfVersion(tariffScheduleVersionId, tx)
    const evaluations = sources.map((source) => evaluateLine(source, rates))
    const result = evaluateRun(evaluations)
    const lineFingerprints = evaluations.map((line, index) => lineFingerprint(sources[index], line, tariffScheduleVersionId))
    const evaluatedAt = (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now

    const run = await createPricingRunRecord(
      {
        claimId,
        pricingContractVersion: PRICING_CONTRACT_VERSION,
        tariffScheduleVersionId,
        providerContractId,
        tariffScheduleId,
        evaluatedAt,
        createdByUserId: actorUserId,
        inputStructureFingerprint: runFingerprint(claimId, tariffScheduleVersionId, lineFingerprints),
        overallResult: result.overallResult,
        lineCount: result.lineCount,
        pricedCount: result.pricedCount,
        currencyCode: result.currencyCode,
        totalExtendedAmount: result.total,
      },
      tx,
    )
    await createPricingLineResults(
      evaluations.map((line, index) => ({
        pricingRunId: run.id,
        claimLineId: line.claimLineId,
        encounterActivityId: line.encounterActivityId,
        tariffRateId: line.tariffRateId,
        lineSequenceAtEvaluation: line.sequence,
        outcome: line.outcome,
        unitTariffAmount: line.unitTariffAmount,
        quantityAtEvaluation: line.quantity,
        extendedAmount: line.extendedAmount,
        currencyCode: line.currencyCode,
        inputFingerprint: lineFingerprints[index],
      })),
      tx,
    )
    await concurrencyProbe('claimPricing.inserted')
    // §11 — the run's identity, status, counts and time only: no money, code, patient or payer value.
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_pricing_run.created',
        entityType: 'CLAIM_PRICING_RUN',
        entityId: run.id,
        beforeState: null,
        afterState: {
          id: run.id,
          claimId,
          pricingContractVersion: PRICING_CONTRACT_VERSION,
          overallResult: run.overallResult,
          lineCount: run.lineCount,
          pricedCount: run.pricedCount,
          evaluatedAt: run.evaluatedAt.toISOString(),
        },
      },
      tx,
    )
    await concurrencyProbe('claimPricing.audited')
    const stored = await findPricingRunById(run.id, tx)
    if (!stored) return refuse('PRICING_CONFLICT', 'the pricing run could not be read back')
    return toRunDto(stored)
  })
}

// ---- reads (§9) ----------------------------------------------------------------------------------

export async function listPricingRuns(claimId: string): Promise<ClaimPricingResult<PricingRunListDto>> {
  if (!isClaimStructureUuid(claimId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid claim id' }
  if (!(await findClaimForStructure(claimId, prisma))) return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
  return { ok: true, value: { items: (await findPricingRunsOfClaim(claimId)).map(toSummaryDto) } }
}

export async function getPricingRun(id: string): Promise<ClaimPricingResult<PricingRunDto>> {
  if (!isClaimStructureUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid pricing run id' }
  const record = await findPricingRunById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'pricing run not found' }
  return { ok: true, value: toRunDto(record) }
}
