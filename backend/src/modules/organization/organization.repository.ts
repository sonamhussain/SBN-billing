import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createOrganizationRecord(name: string) {
  return prisma.organization.create({ data: { name } })
}

export async function findOrganizationById(id: string, db: DbClient = prisma) {
  return db.organization.findUnique({ where: { id } })
}

export async function updateOrganizationRecord(id: string, name: string, db: DbClient = prisma) {
  return db.organization.update({
    where: { id },
    data: { name },
  })
}
