import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createFacilityRecord(organizationId: string, name: string, db: DbClient = prisma) {
  return db.facility.create({ data: { organizationId, name } })
}

export async function findFacilityById(id: string, db: DbClient = prisma) {
  return db.facility.findUnique({ where: { id } })
}

export async function updateFacilityRecord(id: string, name: string, db: DbClient = prisma) {
  return db.facility.update({ where: { id }, data: { name } })
}
