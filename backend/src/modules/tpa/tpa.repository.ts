import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createTpaRecord(organizationId: string, displayName: string, db: DbClient = prisma) {
  return db.tpa.create({ data: { organizationId, displayName } })
}

export async function findTpaById(id: string, db: DbClient = prisma) {
  return db.tpa.findUnique({ where: { id } })
}

export async function findTpasByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.tpa.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateTpaRecord(id: string, displayName: string, db: DbClient = prisma) {
  return db.tpa.update({ where: { id }, data: { displayName } })
}
