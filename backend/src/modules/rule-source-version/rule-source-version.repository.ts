import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createRuleSourceVersionRecord(
  data: { sourceId: string; version: string; rawEvidenceRef: string },
  db: DbClient = prisma,
) {
  return db.ruleSourceVersion.create({ data })
}

export async function findRuleSourceVersionById(id: string, db: DbClient = prisma) {
  return db.ruleSourceVersion.findUnique({ where: { id } })
}

export async function findRuleSourceVersionsBySourceId(sourceId: string, db: DbClient = prisma) {
  return db.ruleSourceVersion.findMany({ where: { sourceId }, orderBy: { createdAt: 'asc' } })
}

export async function findRuleSourceVersionWithOrganization(id: string, db: DbClient = prisma) {
  return db.ruleSourceVersion.findUnique({
    where: { id },
    include: { source: { select: { organizationId: true } } },
  })
}

export async function findRuleSourceVersionForActivation(id: string, db: DbClient = prisma) {
  return db.ruleSourceVersion.findUnique({
    where: { id },
    include: { source: true, interpretations: true },
  })
}

export type RuleSourceVersionLifecycleUpdate = {
  publicationStatus?: string
  publicationDate?: Date | null
  effectiveFrom?: Date | null
  effectiveTo?: Date | null
  verificationStatus?: string
  verifiedAt?: Date | null
  activationStatus?: string
  activationBlockers?: string[]
  activatedAt?: Date | null
  everActivated?: boolean
  firstActivatedAt?: Date | null
  suspendedAt?: Date | null
  supersededAt?: Date | null
  retiredAt?: Date | null
}

export async function updateRuleSourceVersionLifecycle(
  id: string,
  data: RuleSourceVersionLifecycleUpdate,
  db: DbClient = prisma,
) {
  return db.ruleSourceVersion.update({ where: { id }, data })
}
