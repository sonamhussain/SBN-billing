import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createPayerRecord(organizationId: string, displayName: string, db: DbClient = prisma) {
  return db.payer.create({ data: { organizationId, displayName } })
}

export async function findPayerById(id: string, db: DbClient = prisma) {
  return db.payer.findUnique({ where: { id } })
}

export async function findPayersByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.payer.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updatePayerRecord(id: string, displayName: string, db: DbClient = prisma) {
  return db.payer.update({ where: { id }, data: { displayName } })
}
