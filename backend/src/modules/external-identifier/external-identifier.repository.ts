import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export type CreateExternalIdentifierData = {
  organizationId: string
  sourceSystem: string
  externalValue: string
  organizationTargetId?: string
  facilityId?: string
  clinicianId?: string
  specialtyId?: string
  payerId?: string
  tpaId?: string
  networkId?: string
  serviceId?: string
  procedureCodeId?: string
  diagnosisCodeId?: string
}

export async function createExternalIdentifierRecord(
  data: CreateExternalIdentifierData,
  db: DbClient = prisma,
) {
  return db.externalIdentifier.create({ data })
}

export async function findExternalIdentifierById(id: string, db: DbClient = prisma) {
  return db.externalIdentifier.findUnique({ where: { id } })
}

export async function findExternalIdentifiersByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.externalIdentifier.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateExternalIdentifierRecord(
  id: string,
  data: { sourceSystem?: string; externalValue?: string },
  db: DbClient = prisma,
) {
  return db.externalIdentifier.update({ where: { id }, data })
}
