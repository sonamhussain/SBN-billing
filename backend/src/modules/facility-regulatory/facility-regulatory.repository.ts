import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createFacilityRegulatoryProfileRecord(
  data: {
    facilityId: string
    jurisdictionCode: string
    regulatoryAuthorityCode: string
    effectiveFrom: Date
    effectiveTo: Date | null
  },
  db: DbClient = prisma,
) {
  return db.facilityRegulatoryProfile.create({ data: { ...data, status: 'INACTIVE' } })
}

export async function findFacilityRegulatoryProfileById(id: string, db: DbClient = prisma) {
  return db.facilityRegulatoryProfile.findUnique({ where: { id } })
}

export async function findFacilityRegulatoryProfileWithFacility(id: string, db: DbClient = prisma) {
  return db.facilityRegulatoryProfile.findUnique({
    where: { id },
    include: { facility: { select: { organizationId: true } } },
  })
}

export async function findFacilityRegulatoryProfilesByFacilityId(facilityId: string, db: DbClient = prisma) {
  return db.facilityRegulatoryProfile.findMany({ where: { facilityId }, orderBy: { createdAt: 'asc' } })
}

// Every other profile for the same facility that is currently ACTIVE — used to enforce
// non-overlapping effective ranges before a profile is allowed to activate.
export async function findActiveProfilesForFacility(facilityId: string, excludeId: string, db: DbClient = prisma) {
  return db.facilityRegulatoryProfile.findMany({
    where: { facilityId, status: 'ACTIVE', id: { not: excludeId } },
  })
}

// A3.7 server-side resolution (REF-01 / R6): the single ACTIVE profile for this facility whose
// effective range covers businessDate, if any. Non-overlapping ACTIVE ranges (enforced at
// activation time) guarantee at most one match.
export async function findActiveFacilityRegulatoryProfileForDate(
  facilityId: string,
  businessDate: Date,
  db: DbClient = prisma,
) {
  return db.facilityRegulatoryProfile.findFirst({
    where: {
      facilityId,
      status: 'ACTIVE',
      effectiveFrom: { lte: businessDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: businessDate } }],
    },
  })
}

export type FacilityRegulatoryProfileUpdate = {
  jurisdictionCode?: string
  regulatoryAuthorityCode?: string
  effectiveFrom?: Date
  effectiveTo?: Date | null
  status?: string
}

export async function updateFacilityRegulatoryProfileRecord(
  id: string,
  data: FacilityRegulatoryProfileUpdate,
  db: DbClient = prisma,
) {
  return db.facilityRegulatoryProfile.update({ where: { id }, data })
}
