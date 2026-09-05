import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createClinicianRecord(organizationId: string, displayName: string, db: DbClient = prisma) {
  return db.clinician.create({ data: { organizationId, displayName } })
}

export async function findClinicianById(id: string, db: DbClient = prisma) {
  return db.clinician.findUnique({ where: { id } })
}

export async function findCliniciansByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.clinician.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateClinicianRecord(id: string, displayName: string, db: DbClient = prisma) {
  return db.clinician.update({ where: { id }, data: { displayName } })
}
