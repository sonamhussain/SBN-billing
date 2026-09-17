import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createReferenceDatasetRecord(
  data: { datasetKey: string; displayName: string; jurisdictionCode: string; authorityCode: string },
  db: DbClient = prisma,
) {
  return db.referenceDataset.create({ data })
}

export async function findReferenceDatasetById(id: string, db: DbClient = prisma) {
  return db.referenceDataset.findUnique({ where: { id } })
}

export async function findAllReferenceDatasets(db: DbClient = prisma) {
  return db.referenceDataset.findMany({ orderBy: { createdAt: 'asc' } })
}

export async function createReferenceDatasetVersionRecord(
  data: {
    datasetId: string
    sourceVersionId: string | null
    version: string
    retrievedAt: Date
    publicationDate: Date | null
    effectiveFrom: Date | null
    effectiveTo: Date | null
    contentHash: string
  },
  db: DbClient = prisma,
) {
  return db.referenceDatasetVersion.create({
    data: { ...data, validationStatus: 'UNVALIDATED', activationStatus: 'INACTIVE' },
  })
}

export async function findReferenceDatasetVersionById(id: string, db: DbClient = prisma) {
  return db.referenceDatasetVersion.findUnique({ where: { id } })
}

export async function findReferenceDatasetVersionsByDatasetId(datasetId: string, db: DbClient = prisma) {
  return db.referenceDatasetVersion.findMany({ where: { datasetId }, orderBy: { createdAt: 'asc' } })
}

// The currently ACTIVE version for a dataset, if any — activating a new version supersedes
// this one automatically (a dataset has at most one ACTIVE version at a time).
export async function findActiveVersionForDataset(datasetId: string, excludeId: string, db: DbClient = prisma) {
  return db.referenceDatasetVersion.findFirst({ where: { datasetId, activationStatus: 'ACTIVE', id: { not: excludeId } } })
}

export type ReferenceDatasetVersionUpdate = {
  validationStatus?: string
  activationStatus?: string
  activatedAt?: Date | null
  supersededAt?: Date | null
  retiredAt?: Date | null
}

export async function updateReferenceDatasetVersionRecord(
  id: string,
  data: ReferenceDatasetVersionUpdate,
  db: DbClient = prisma,
) {
  return db.referenceDatasetVersion.update({ where: { id }, data })
}

// Audit F12 — append-only. There is deliberately no update or delete counterpart here, and the
// database rejects both with a trigger.
export async function recordReferenceDatasetLifecycleEvent(
  data: {
    datasetId: string
    datasetVersionId: string
    action: string
    previousActivationStatus: string
    nextActivationStatus: string
    previousValidationStatus: string
    nextValidationStatus: string
    actorRef: string
    reason: string | null
  },
  db: DbClient = prisma,
) {
  return db.referenceDatasetLifecycleEvent.create({ data })
}

export async function findReferenceDatasetLifecycleEvents(datasetId: string, db: DbClient = prisma) {
  return db.referenceDatasetLifecycleEvent.findMany({ where: { datasetId }, orderBy: { sequence: 'asc' } })
}
