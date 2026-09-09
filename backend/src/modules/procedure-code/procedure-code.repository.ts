import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createProcedureCodeRecord(
  organizationId: string,
  internalCode: string,
  displayName: string,
  codeSystem: string | null,
  externalCode: string | null,
  db: DbClient = prisma,
) {
  return db.procedureCode.create({
    data: { organizationId, internalCode, displayName, codeSystem, externalCode },
  })
}

export async function findProcedureCodeById(id: string, db: DbClient = prisma) {
  return db.procedureCode.findUnique({ where: { id } })
}

export async function findProcedureCodesByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.procedureCode.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateProcedureCodeRecord(
  id: string,
  data: { internalCode?: string; displayName?: string; codeSystem?: string | null; externalCode?: string | null },
  db: DbClient = prisma,
) {
  return db.procedureCode.update({ where: { id }, data })
}
