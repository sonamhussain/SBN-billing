import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createServiceRecord(
  organizationId: string,
  internalCode: string,
  displayName: string,
  db: DbClient = prisma,
) {
  return db.service.create({ data: { organizationId, internalCode, displayName } })
}

export async function findServiceById(id: string, db: DbClient = prisma) {
  return db.service.findUnique({ where: { id } })
}

export async function findServicesByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.service.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateServiceRecord(
  id: string,
  data: { internalCode?: string; displayName?: string },
  db: DbClient = prisma,
) {
  return db.service.update({ where: { id }, data })
}
