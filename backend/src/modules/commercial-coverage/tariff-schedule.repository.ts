import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createTariffScheduleRecord(
  data: { providerContractId: string; tariffKey: string; displayName: string },
  db: DbClient = prisma,
) {
  return db.tariffSchedule.create({ data })
}

export async function findTariffScheduleById(id: string, db: DbClient = prisma) {
  return db.tariffSchedule.findUnique({ where: { id } })
}

export async function findTariffScheduleWithContract(id: string, db: DbClient = prisma) {
  return db.tariffSchedule.findUnique({
    where: { id },
    include: { providerContract: { select: { organizationId: true } } },
  })
}

export async function findTariffSchedulesByContractId(providerContractId: string, db: DbClient = prisma) {
  return db.tariffSchedule.findMany({ where: { providerContractId }, orderBy: { createdAt: 'asc' } })
}

export async function updateTariffScheduleDisplayName(id: string, displayName: string, db: DbClient = prisma) {
  return db.tariffSchedule.update({ where: { id }, data: { displayName } })
}

export async function createTariffScheduleVersionRecord(
  data: { tariffScheduleId: string; version: string; effectiveFrom: Date | null; effectiveTo: Date | null },
  db: DbClient = prisma,
) {
  return db.tariffScheduleVersion.create({ data })
}

export async function findTariffScheduleVersionById(id: string, db: DbClient = prisma) {
  return db.tariffScheduleVersion.findUnique({ where: { id } })
}

export async function findTariffScheduleVersionWithSchedule(id: string, db: DbClient = prisma) {
  return db.tariffScheduleVersion.findUnique({
    where: { id },
    include: { tariffSchedule: { include: { providerContract: { select: { organizationId: true } } } } },
  })
}

export async function findTariffScheduleVersionsByScheduleId(tariffScheduleId: string, db: DbClient = prisma) {
  return db.tariffScheduleVersion.findMany({ where: { tariffScheduleId }, orderBy: { createdAt: 'asc' } })
}

export type TariffScheduleVersionUpdate = {
  effectiveFrom?: Date | null
  effectiveTo?: Date | null
  verificationStatus?: string
  verifiedAt?: Date | null
}

export async function updateTariffScheduleVersionRecord(id: string, data: TariffScheduleVersionUpdate, db: DbClient = prisma) {
  return db.tariffScheduleVersion.update({ where: { id }, data })
}
