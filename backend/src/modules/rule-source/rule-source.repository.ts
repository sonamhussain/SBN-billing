import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createRuleSourceRecord(
  data: {
    organizationId: string
    jurisdictionCode: string
    issuingAuthority: string
    sourceCategory: string
    referenceNumber: string
    title: string
    ownershipScope: string
  },
  db: DbClient = prisma,
) {
  return db.ruleSource.create({ data })
}

export async function findRuleSourceById(id: string, db: DbClient = prisma) {
  return db.ruleSource.findUnique({ where: { id } })
}

export async function findRuleSourcesByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.ruleSource.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

// Audit F10: identity fields freeze as soon as the source has any version, because A3.7/A3.8 read
// the parent fields live and an edit would silently relabel every existing version and binding.
export async function countRuleSourceVersions(sourceId: string, db: DbClient = prisma) {
  return db.ruleSourceVersion.count({ where: { sourceId } })
}

export async function updateRuleSourceRecord(
  id: string,
  data: {
    jurisdictionCode?: string
    issuingAuthority?: string
    sourceCategory?: string
    referenceNumber?: string
    title?: string
  },
  db: DbClient = prisma,
) {
  return db.ruleSource.update({ where: { id }, data })
}
