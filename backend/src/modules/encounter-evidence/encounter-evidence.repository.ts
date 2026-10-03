import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A5.6 — Prisma access for Encounter evidence links. A link stores two ids and its own lifecycle;
// nothing about the evidence is read or copied here. There is no delete function: correction is the
// one-way removal below, and the database refuses a delete outright.

export async function findEncounterOwnership(encounterId: string, db: DbClient = prisma) {
  return db.encounter.findUnique({ where: { id: encounterId }, select: { patient: { select: { organizationId: true } } } })
}

export async function findLinkOwnership(linkId: string, db: DbClient = prisma) {
  return db.encounterEvidenceLink.findUnique({
    where: { id: linkId },
    select: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
}

export async function findEncounterOrganization(encounterId: string, db: DbClient) {
  return db.encounter.findUnique({ where: { id: encounterId }, select: { id: true, patient: { select: { organizationId: true } } } })
}

export async function findActiveLink(encounterId: string, evidenceArtifactVersionId: string, db: DbClient) {
  return db.encounterEvidenceLink.findFirst({ where: { encounterId, evidenceArtifactVersionId, removedAt: null }, select: { id: true } })
}

export async function createLinkRecord(encounterId: string, evidenceArtifactVersionId: string, createdByUserId: string, db: DbClient) {
  return db.encounterEvidenceLink.create({ data: { encounterId, evidenceArtifactVersionId, createdByUserId } })
}

// Active links only, in creation order then id: deterministic, never a ranking.
export async function findActiveLinks(encounterId: string, db: DbClient = prisma) {
  return db.encounterEvidenceLink.findMany({ where: { encounterId, removedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

// By id, a removed link is still readable: it is history.
export async function findLinkById(linkId: string, db: DbClient = prisma) {
  return db.encounterEvidenceLink.findUnique({ where: { id: linkId } })
}

export async function findLinkWithOrganization(linkId: string, db: DbClient) {
  return db.encounterEvidenceLink.findUnique({
    where: { id: linkId },
    include: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
}

export async function removeLinkRecord(linkId: string, removedAt: Date, db: DbClient) {
  return db.encounterEvidenceLink.update({ where: { id: linkId }, data: { removedAt } })
}
