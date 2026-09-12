import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createSourceInterpretationRecord(
  data: {
    sourceVersionId: string
    interpretationVersion: string
    normalizedInterpretationRef: string
    verificationStatus: string
  },
  db: DbClient = prisma,
) {
  return db.sourceInterpretation.create({ data })
}

export async function findSourceInterpretationById(id: string, db: DbClient = prisma) {
  return db.sourceInterpretation.findUnique({ where: { id } })
}

export async function findSourceInterpretationsByVersionId(sourceVersionId: string, db: DbClient = prisma) {
  return db.sourceInterpretation.findMany({ where: { sourceVersionId }, orderBy: { createdAt: 'asc' } })
}

export async function updateSourceInterpretationRecord(
  id: string,
  data: { normalizedInterpretationRef?: string; verificationStatus?: string; verifiedAt?: Date | null },
  db: DbClient = prisma,
) {
  return db.sourceInterpretation.update({ where: { id }, data })
}

export async function findSourceInterpretationWithOrganization(id: string, db: DbClient = prisma) {
  return db.sourceInterpretation.findUnique({
    where: { id },
    include: { sourceVersion: { include: { source: { select: { organizationId: true } } } } },
  })
}
