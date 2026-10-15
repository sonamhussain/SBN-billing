import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.3 — Prisma access for tariff rates. There is no delete and no update of a rate's identity or amount:
// the only change is one retirement, and the database refuses everything else. REF-01 owns the tariff
// version and its verification; this module only reads it.

// Ownership and lifecycle of a tariff version: its status and its contract's organization only.
export async function findTariffVersionScope(versionId: string, db: DbClient = prisma) {
  const row = await db.tariffScheduleVersion.findUnique({
    where: { id: versionId },
    select: { id: true, verificationStatus: true, tariffSchedule: { select: { providerContract: { select: { organizationId: true } } } } },
  })
  return row ? { id: row.id, verificationStatus: row.verificationStatus, organizationId: row.tariffSchedule.providerContract.organizationId } : null
}

// The owning organization of a rate, through its version's contract.
export async function findTariffRateOwnership(rateId: string, db: DbClient = prisma) {
  const row = await db.tariffRate.findUnique({
    where: { id: rateId },
    select: { tariffScheduleVersion: { select: { tariffSchedule: { select: { providerContract: { select: { organizationId: true } } } } } } },
  })
  return row ? { organizationId: row.tariffScheduleVersion.tariffSchedule.providerContract.organizationId } : null
}

export async function findServiceOrganization(id: string, db: DbClient) {
  return db.service.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findProcedureCodeOrganization(id: string, db: DbClient) {
  return db.procedureCode.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findActiveRateWithIdentity(
  identity: { tariffScheduleVersionId: string; selectorKind: string; serviceId: string | null; procedureCodeId: string | null; unitCodeKey: string | null; modifierSignature: string[] },
  db: DbClient,
) {
  return db.tariffRate.findFirst({
    where: {
      tariffScheduleVersionId: identity.tariffScheduleVersionId,
      selectorKind: identity.selectorKind,
      serviceId: identity.serviceId,
      procedureCodeId: identity.procedureCodeId,
      unitCodeKey: identity.unitCodeKey,
      modifierSignature: { equals: identity.modifierSignature },
      removedAt: null,
    },
    select: { id: true },
  })
}

export async function createTariffRateRecord(data: Prisma.TariffRateUncheckedCreateInput, db: DbClient) {
  return db.tariffRate.create({ data })
}

export async function findTariffRateById(id: string, db: DbClient = prisma) {
  return db.tariffRate.findUnique({ where: { id } })
}

// Every rate of a version, active and retired, in a fixed history order.
export async function findTariffRatesOfVersion(versionId: string, db: DbClient = prisma) {
  return db.tariffRate.findMany({ where: { tariffScheduleVersionId: versionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

// The database stamps removed_at with its own transaction time; the value sent here is replaced.
export async function markTariffRateRetired(id: string, db: DbClient) {
  return db.tariffRate.update({ where: { id }, data: { removedAt: new Date() } })
}
