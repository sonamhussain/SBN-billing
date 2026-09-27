import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A5.1 — data loading and the two inserts, nothing else. Every function takes the caller's
// transaction client, because creating an artifact with its first version, and appending a later
// one, each have to be one atomic unit together with their audit record.
//
// There is deliberately no update and no delete function anywhere in this file. A version is
// append-only, and the database enforces that with a trigger, but the repository should not even
// offer the shape of an operation the domain forbids.

export async function createEvidenceArtifactRecord(organizationId: string, db: DbClient) {
  return db.evidenceArtifact.create({ data: { organizationId } })
}

export async function createEvidenceVersionRecord(
  data: {
    evidenceArtifactId: string
    version: number
    storageRef: string
    contentHash: string
    documentType: string
    sourceDate: Date | null
    receivedAt: Date
    createdByUserId: string
  },
  db: DbClient,
) {
  return db.evidenceArtifactVersion.create({ data })
}

export async function findEvidenceArtifactById(id: string, db: DbClient = prisma) {
  return db.evidenceArtifact.findUnique({ where: { id } })
}

// The minimal projection the route needs to authorize a by-id request: who owns this artifact, and
// nothing about what it contains. Loading the whole row to answer an ownership question would read
// more than the decision requires.
export async function findEvidenceArtifactOwnership(id: string, db: DbClient = prisma) {
  return db.evidenceArtifact.findUnique({ where: { id }, select: { id: true, organizationId: true } })
}

export async function findEvidenceVersionOwnership(id: string, db: DbClient = prisma) {
  return db.evidenceArtifactVersion.findUnique({
    where: { id },
    select: { id: true, evidenceArtifact: { select: { organizationId: true } } },
  })
}

export async function findEvidenceVersionById(id: string, db: DbClient = prisma) {
  return db.evidenceArtifactVersion.findUnique({ where: { id } })
}

export async function findEvidenceArtifactsByOrganization(organizationId: string, db: DbClient = prisma) {
  return db.evidenceArtifact.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
}

export async function findEvidenceArtifactWithLatestVersion(id: string, db: DbClient = prisma) {
  return db.evidenceArtifact.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
}

// Ascending on purpose: a version list is a history, and a history reads forwards.
export async function findEvidenceVersions(evidenceArtifactId: string, db: DbClient = prisma) {
  return db.evidenceArtifactVersion.findMany({
    where: { evidenceArtifactId },
    orderBy: { version: 'asc' },
  })
}

// Read INSIDE the artifact's row lock. Reading it outside would let two writers both see the same
// maximum and both claim the next number; one of them would then lose to the unique index, and a
// caller that did nothing wrong would get an error.
export async function findMaxVersionNumber(evidenceArtifactId: string, db: DbClient): Promise<number | null> {
  const result = await db.evidenceArtifactVersion.aggregate({
    where: { evidenceArtifactId },
    _max: { version: true },
  })
  return result._max.version ?? null
}
