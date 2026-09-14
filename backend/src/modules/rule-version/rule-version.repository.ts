import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createRuleVersionRecord(
  data: {
    ruleId: string
    version: string
    effectType: string
    effectiveFrom: Date | null
    effectiveTo: Date | null
  },
  db: DbClient = prisma,
) {
  return db.ruleVersion.create({ data })
}

export async function findRuleVersionById(id: string, db: DbClient = prisma) {
  return db.ruleVersion.findUnique({ where: { id } })
}

export async function findRuleVersionsByRuleId(ruleId: string, db: DbClient = prisma) {
  return db.ruleVersion.findMany({ where: { ruleId }, orderBy: { createdAt: 'asc' } })
}

export async function findRuleVersionWithOrganization(id: string, db: DbClient = prisma) {
  return db.ruleVersion.findUnique({
    where: { id },
    include: { rule: { select: { organizationId: true } } },
  })
}

export type RuleVersionUpdate = {
  effectType?: string
  effectiveFrom?: Date | null
  effectiveTo?: Date | null
  verificationStatus?: string
  verifiedAt?: Date | null
}

export async function updateRuleVersionRecord(id: string, data: RuleVersionUpdate, db: DbClient = prisma) {
  return db.ruleVersion.update({ where: { id }, data })
}
