import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createDiagnosisCodeRecord(
  organizationId: string,
  code: string,
  displayName: string,
  db: DbClient = prisma,
) {
  return db.diagnosisCode.create({ data: { organizationId, code, displayName } })
}

export async function findDiagnosisCodeById(id: string, db: DbClient = prisma) {
  return db.diagnosisCode.findUnique({ where: { id } })
}

export async function findDiagnosisCodesByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.diagnosisCode.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateDiagnosisCodeRecord(
  id: string,
  data: { code?: string; displayName?: string },
  db: DbClient = prisma,
) {
  return db.diagnosisCode.update({ where: { id }, data })
}
