import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createRelationshipRecord(
  data: { fromSourceVersionId: string; toSourceVersionId: string; relationshipType: string },
  db: DbClient = prisma,
) {
  return db.ruleSourceRelationship.create({ data })
}

export async function findRelationshipById(id: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.findUnique({ where: { id } })
}

export async function findRelationshipWithParents(id: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.findUnique({
    where: { id },
    include: {
      fromSourceVersion: { include: { source: { select: { organizationId: true } } } },
      toSourceVersion: { include: { source: { select: { organizationId: true } } } },
    },
  })
}

export async function findOutgoingRelationships(versionId: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.findMany({ where: { fromSourceVersionId: versionId }, orderBy: { createdAt: 'asc' } })
}

export async function findIncomingRelationships(versionId: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.findMany({ where: { toSourceVersionId: versionId }, orderBy: { createdAt: 'asc' } })
}

export async function findOutgoingSupersedesTargets(versionId: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.findMany({
    where: { fromSourceVersionId: versionId, relationshipType: 'SUPERSEDES' },
    select: { toSourceVersionId: true },
  })
}

export async function findOutgoingDependsOnTargets(versionId: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.findMany({
    where: { fromSourceVersionId: versionId, relationshipType: 'DEPENDS_ON' },
    select: {
      toSourceVersion: { select: { activationStatus: true } },
    },
  })
}

export async function countConflictsTouchingVersion(versionId: string, db: DbClient = prisma) {
  return db.ruleSourceRelationship.count({
    where: {
      relationshipType: 'CONFLICTS_WITH',
      OR: [{ fromSourceVersionId: versionId }, { toSourceVersionId: versionId }],
    },
  })
}
