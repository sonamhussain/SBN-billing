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

// Audit F05: every writer that can change which profiles are ACTIVE, or the period of an ACTIVE
// profile, takes this row lock on the parent facility first and holds it through write + audit.
// That serialises activation and update for one facility, so a status/period check can never be
// invalidated by a competing writer between the read and the write.
export async function lockFacilityForRegulatoryChange(facilityId: string, db: DbClient) {
  await db.$queryRaw`SELECT id FROM facilities WHERE id = ${facilityId}::uuid FOR UPDATE`
}

export type FacilityProfileResolution<T> =
  | { kind: 'none' }
  | { kind: 'one'; profile: T }
  | { kind: 'many'; profileIds: string[] }

// A3.7/A3.8 server-side resolution (REF-01 / R6, audit F05): the ACTIVE profile(s) whose effective
// range covers the date, reported as an explicit zero / one / many result. Non-overlap is enforced
// on write, but a stored ambiguity must never be hidden by picking a row (the previous findFirst
// did exactly that) — the caller fails closed on anything other than exactly one. No ordering is
// applied: createdAt, UUID and row order are never a selection rule.
export async function resolveFacilityRegulatoryProfileForDate(
  facilityId: string,
  businessDate: Date,
  db: DbClient = prisma,
) {
  const matches = await db.facilityRegulatoryProfile.findMany({
    where: {
      facilityId,
      status: 'ACTIVE',
      effectiveFrom: { lte: businessDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: businessDate } }],
    },
    take: 2,
  })
  type Profile = (typeof matches)[number]
  if (matches.length === 0) return { kind: 'none' } as FacilityProfileResolution<Profile>
  if (matches.length === 1) return { kind: 'one', profile: matches[0] } as FacilityProfileResolution<Profile>
  return { kind: 'many', profileIds: matches.map((match) => match.id) } as FacilityProfileResolution<Profile>
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
