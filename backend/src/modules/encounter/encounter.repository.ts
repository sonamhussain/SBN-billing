import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A4.4 — Prisma access only. No validation, authorization or audit decision lives here, and there
// is deliberately no delete function: an Encounter is corrected, never removed.

// ---- pre-authorization ownership (minimal selects) -------------------------------------------
// Authorization runs before the caller is known to be allowed to see anything, so these return
// the owning organization ONLY — never a service date, provider, membership or context ID.

export async function findPatientOwnership(patientId: string, db: DbClient = prisma) {
  return db.patient.findUnique({ where: { id: patientId }, select: { organizationId: true } })
}

export async function findEncounterOwnership(id: string, db: DbClient = prisma) {
  const row = await db.encounter.findUnique({ where: { id }, select: { patient: { select: { organizationId: true } } } })
  return row ? { organizationId: row.patient.organizationId } : null
}

// ---- context ownership facts (read after the locks are held) -------------------------------

export async function findClinicianOwnership(id: string, db: DbClient = prisma) {
  return db.clinician.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findFacilityOwnership(id: string, db: DbClient = prisma) {
  return db.facility.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findMembershipContext(id: string, db: DbClient = prisma) {
  return db.insuranceMembership.findUnique({ where: { id }, select: { patientId: true, coverageFrom: true, coverageTo: true } })
}

// ---- encounters --------------------------------------------------------------------------------

export type EncounterRecordInput = {
  patientId: string
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  serviceDate: Date
  clinicianFacilityAssignmentId: string
  facilityRegulatoryProfileId: string
}

export async function createEncounterRecord(input: EncounterRecordInput, db: DbClient = prisma) {
  return db.encounter.create({ data: input })
}

export async function findEncounterById(id: string, db: DbClient = prisma) {
  return db.encounter.findUnique({ where: { id } })
}

export async function findEncountersByPatientId(patientId: string, db: DbClient = prisma) {
  return db.encounter.findMany({ where: { patientId }, orderBy: [{ serviceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
}

export async function updateEncounterRecord(id: string, data: Partial<Omit<EncounterRecordInput, 'patientId'>>, db: DbClient = prisma) {
  return db.encounter.update({ where: { id }, data })
}
