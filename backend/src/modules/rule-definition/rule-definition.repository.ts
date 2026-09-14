import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createRuleDefinitionRecord(
  data: {
    organizationId: string
    ruleKey: string
    displayName: string
    jurisdictionCode: string
    ownershipScope: string
  },
  db: DbClient = prisma,
) {
  return db.ruleDefinition.create({ data })
}

export async function findRuleDefinitionById(id: string, db: DbClient = prisma) {
  return db.ruleDefinition.findUnique({ where: { id } })
}

export async function findRuleDefinitionsByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.ruleDefinition.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateRuleDefinitionRecord(
  id: string,
  data: { displayName: string },
  db: DbClient = prisma,
) {
  return db.ruleDefinition.update({ where: { id }, data })
}
