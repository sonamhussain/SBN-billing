import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export type CreateExternalIdentifierData = {
  organizationId: string
  sourceSystem: string
  externalValue: string
  organizationTargetId?: string
  facilityId?: string
  clinicianId?: string
  specialtyId?: string
  payerId?: string
  tpaId?: string
  networkId?: string
  serviceId?: string
  procedureCodeId?: string
  diagnosisCodeId?: string
  patientId?: string
  encounterId?: string
}

export async function createExternalIdentifierRecord(
  data: CreateExternalIdentifierData,
  db: DbClient = prisma,
) {
  return db.externalIdentifier.create({ data })
}

export async function findExternalIdentifierById(id: string, db: DbClient = prisma) {
  return db.externalIdentifier.findUnique({ where: { id } })
}

export async function findExternalIdentifiersByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.externalIdentifier.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

// A4.9 — the mappings that name one Patient or one Encounter, and nothing else. The organization's
// other identifiers are deliberately out of reach here: a billing context carries the mappings for
// its own subject, not an organization-wide directory. The caller passes its read snapshot so these
// rows belong to the same point in time as the rest of the bundle.
export async function findExternalIdentifiersForEncounterContext(
  patientId: string,
  encounterId: string,
  db: DbClient = prisma,
) {
  return db.externalIdentifier.findMany({
    where: { OR: [{ patientId }, { encounterId }] },
    orderBy: [{ sourceSystem: 'asc' }, { externalValue: 'asc' }, { id: 'asc' }],
  })
}

export async function updateExternalIdentifierRecord(
  id: string,
  data: { sourceSystem?: string; externalValue?: string },
  db: DbClient = prisma,
) {
  return db.externalIdentifier.update({ where: { id }, data })
}
