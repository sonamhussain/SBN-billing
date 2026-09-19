import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// ---- RulePack ------------------------------------------------------------------------------

export async function createRulePackRecord(
  data: { organizationId: string; packKey: string; displayName: string; jurisdictionCode: string; ownershipScope: string },
  db: DbClient = prisma,
) {
  return db.rulePack.create({ data })
}

export async function findRulePackById(id: string, db: DbClient = prisma) {
  return db.rulePack.findUnique({ where: { id } })
}

export async function findRulePacksByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.rulePack.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateRulePackRecord(id: string, data: { displayName: string }, db: DbClient = prisma) {
  return db.rulePack.update({ where: { id }, data })
}

// ---- RulePackVersion ----------------------------------------------------------------------

export async function createRulePackVersionRecord(
  data: { rulePackId: string; version: string; effectiveFrom: Date | null; effectiveTo: Date | null },
  db: DbClient = prisma,
) {
  // A new version is always a draft; the lifecycle fields are never taken from the caller.
  return db.rulePackVersion.create({ data: { ...data, verificationStatus: 'UNVERIFIED', activationStatus: 'INACTIVE' } })
}

export async function findRulePackVersionById(id: string, db: DbClient = prisma) {
  return db.rulePackVersion.findUnique({ where: { id } })
}

export async function findRulePackVersionWithPack(id: string, db: DbClient = prisma) {
  return db.rulePackVersion.findUnique({ where: { id }, include: { rulePack: true } })
}

// Listing order is presentation only (creation order). It is never used to decide which version
// is current — that is the ACTIVE status alone.
export async function findRulePackVersionsByPackId(rulePackId: string, db: DbClient = prisma) {
  return db.rulePackVersion.findMany({ where: { rulePackId }, orderBy: { createdAt: 'asc' } })
}

export async function findActiveRulePackVersion(rulePackId: string, excludeId: string, db: DbClient = prisma) {
  return db.rulePackVersion.findFirst({ where: { rulePackId, activationStatus: 'ACTIVE', id: { not: excludeId } } })
}

export type RulePackVersionUpdate = {
  effectiveFrom?: Date | null
  effectiveTo?: Date | null
  verificationStatus?: string
  verifiedAt?: Date | null
  activationStatus?: string
  activatedAt?: Date | null
  supersededAt?: Date | null
}

export async function updateRulePackVersionRecord(id: string, data: RulePackVersionUpdate, db: DbClient = prisma) {
  return db.rulePackVersion.update({ where: { id }, data })
}

// ---- RulePackMember -----------------------------------------------------------------------

export async function createRulePackMemberRecord(
  data: { rulePackVersionId: string; ruleVersionId: string },
  db: DbClient = prisma,
) {
  return db.rulePackMember.create({ data })
}

export async function findRulePackMemberById(id: string, db: DbClient = prisma) {
  return db.rulePackMember.findUnique({ where: { id } })
}

export async function findRulePackMemberWithPack(id: string, db: DbClient = prisma) {
  return db.rulePackMember.findUnique({ where: { id }, include: { rulePackVersion: { include: { rulePack: true } } } })
}

export async function findRulePackMembersByVersionId(rulePackVersionId: string, db: DbClient = prisma) {
  return db.rulePackMember.findMany({ where: { rulePackVersionId }, orderBy: { createdAt: 'asc' } })
}

export async function findRulePackMembersForVerification(rulePackVersionId: string, db: DbClient = prisma) {
  return db.rulePackMember.findMany({
    where: { rulePackVersionId },
    include: { ruleVersion: { select: { id: true, verificationStatus: true, rule: { select: { organizationId: true, jurisdictionCode: true } } } } },
    orderBy: { ruleVersionId: 'asc' },
  })
}

export async function deleteRulePackMemberRecord(id: string, db: DbClient = prisma) {
  return db.rulePackMember.delete({ where: { id } })
}

export async function findRuleVersionForMembership(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleVersion.findUnique({
    where: { id: ruleVersionId },
    select: { id: true, verificationStatus: true, rule: { select: { organizationId: true, jurisdictionCode: true } } },
  })
}
