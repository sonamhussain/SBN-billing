import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createNetworkRecord(organizationId: string, displayName: string, db: DbClient = prisma) {
  return db.network.create({ data: { organizationId, displayName } })
}

export async function findNetworkById(id: string, db: DbClient = prisma) {
  return db.network.findUnique({ where: { id } })
}

export async function findNetworksByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.network.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateNetworkRecord(id: string, displayName: string, db: DbClient = prisma) {
  return db.network.update({ where: { id }, data: { displayName } })
}
