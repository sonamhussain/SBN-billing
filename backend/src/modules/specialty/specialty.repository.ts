import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createSpecialtyRecord(organizationId: string, displayName: string, db: DbClient = prisma) {
  return db.specialty.create({ data: { organizationId, displayName } })
}

export async function findSpecialtyById(id: string, db: DbClient = prisma) {
  return db.specialty.findUnique({ where: { id } })
}

export async function findSpecialtiesByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.specialty.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateSpecialtyRecord(id: string, displayName: string, db: DbClient = prisma) {
  return db.specialty.update({ where: { id }, data: { displayName } })
}
