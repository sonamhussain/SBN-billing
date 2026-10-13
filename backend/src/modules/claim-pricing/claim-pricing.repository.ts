import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.3 — Prisma access for pricing. Runs and line results are only ever inserted; the database refuses
// any update or delete. The bound commercial lineage is read from the Claim's own A5 chain, never
// re-resolved; Claim lines and source activities are read, never changed.

// §7.3 — the exact commercial IDs and service date of the ValidationRun the Claim is bound to.
export async function findBoundCommercialLineage(claimId: string, db: DbClient) {
  const row = await db.claim.findUnique({
    where: { id: claimId },
    select: {
      preClaimReadinessAssessment: {
        select: { validationRun: { select: { serviceDate: true, providerContractId: true, tariffScheduleId: true, tariffScheduleVersionId: true } } },
      },
    },
  })
  return row?.preClaimReadinessAssessment.validationRun ?? null
}

// The tariff version with its schedule's contract, for the lineage coherence and effective-date checks.
export async function findTariffVersionLineage(versionId: string, db: DbClient) {
  return db.tariffScheduleVersion.findUnique({
    where: { id: versionId },
    select: { id: true, tariffScheduleId: true, verificationStatus: true, effectiveFrom: true, effectiveTo: true, tariffSchedule: { select: { providerContractId: true } } },
  })
}

// §7.4 — the Claim's active lines in Claim order with every source row and the exact source facts.
export async function findActiveLinesWithSources(claimId: string, db: DbClient) {
  return db.claimLine.findMany({
    where: { claimId, removedAt: null },
    orderBy: [{ sequence: 'asc' }],
    select: {
      id: true,
      sequence: true,
      sources: {
        select: {
          encounterActivity: {
            select: {
              id: true,
              encounterId: true,
              serviceId: true,
              procedureCodeId: true,
              quantity: true,
              unitCode: true,
              removedAt: true,
              modifiers: { orderBy: { sequence: 'asc' }, select: { code: true } },
            },
          },
        },
      },
    },
  })
}

// §7.5 — the active rates of the one bound tariff version.
export async function findActiveRatesOfVersion(versionId: string, db: DbClient) {
  return db.tariffRate.findMany({ where: { tariffScheduleVersionId: versionId, removedAt: null }, orderBy: [{ id: 'asc' }] })
}

export async function createPricingRunRecord(data: Prisma.ClaimPricingRunUncheckedCreateInput, db: DbClient) {
  return db.claimPricingRun.create({ data })
}

export async function createPricingLineResults(data: Prisma.ClaimPricingLineResultUncheckedCreateInput[], db: DbClient) {
  if (data.length === 0) return
  await db.claimPricingLineResult.createMany({ data })
}

const withLines = { lineResults: { orderBy: { lineSequenceAtEvaluation: 'asc' } } } as const

export async function findPricingRunById(id: string, db: DbClient = prisma) {
  return db.claimPricingRun.findUnique({ where: { id }, include: withLines })
}

// History order (evaluatedAt DESC, then id ASC) — never a "current" pricing run.
export async function findPricingRunsOfClaim(claimId: string, db: DbClient = prisma) {
  return db.claimPricingRun.findMany({ where: { claimId }, orderBy: [{ evaluatedAt: 'desc' }, { id: 'asc' }] })
}

// The owning organization of a pricing run, through its Claim.
export async function findPricingRunOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimPricingRun.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}
