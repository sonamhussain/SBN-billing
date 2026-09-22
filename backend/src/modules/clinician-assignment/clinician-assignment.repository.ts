import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A4.2 — Prisma access only. Ownership lookups fetch the organization column and nothing else:
// authorization runs before the caller is known to be allowed to see the record at all.

export async function findClinicianOwnership(id: string, db: DbClient = prisma) {
  return db.clinician.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findFacilityOwnership(id: string, db: DbClient = prisma) {
  return db.facility.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findSpecialtyOwnership(id: string, db: DbClient = prisma) {
  return db.specialty.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findFacilityAssignmentOwnership(id: string, db: DbClient = prisma) {
  return db.clinicianFacilityAssignment.findUnique({ where: { id }, select: { clinician: { select: { organizationId: true } } } })
}

export async function findSpecialtyAssignmentOwnership(id: string, db: DbClient = prisma) {
  return db.clinicianSpecialtyAssignment.findUnique({ where: { id }, select: { clinician: { select: { organizationId: true } } } })
}

// ---- facility assignments ------------------------------------------------------------------

export async function findFacilityAssignmentById(id: string, db: DbClient = prisma) {
  return db.clinicianFacilityAssignment.findUnique({ where: { id } })
}

export async function findFacilityAssignmentsByClinician(clinicianId: string, db: DbClient = prisma) {
  return db.clinicianFacilityAssignment.findMany({ where: { clinicianId }, orderBy: { effectiveFrom: 'asc' } })
}

// Every stored period for this exact pair; the pure overlap rule decides, so the query itself
// stays trivial and the decision is testable without a database.
export async function findFacilityAssignmentsForPair(clinicianId: string, facilityId: string, db: DbClient = prisma) {
  return db.clinicianFacilityAssignment.findMany({ where: { clinicianId, facilityId } })
}

export async function createFacilityAssignmentRecord(
  input: { clinicianId: string; facilityId: string; effectiveFrom: Date; effectiveTo: Date | null },
  db: DbClient = prisma,
) {
  return db.clinicianFacilityAssignment.create({ data: input })
}

export async function closeFacilityAssignmentRecord(id: string, effectiveTo: Date, db: DbClient = prisma) {
  return db.clinicianFacilityAssignment.update({ where: { id }, data: { effectiveTo } })
}

// ---- specialty assignments -----------------------------------------------------------------

export async function findSpecialtyAssignmentById(id: string, db: DbClient = prisma) {
  return db.clinicianSpecialtyAssignment.findUnique({ where: { id } })
}

export async function findSpecialtyAssignmentsByClinician(clinicianId: string, db: DbClient = prisma) {
  return db.clinicianSpecialtyAssignment.findMany({ where: { clinicianId }, orderBy: { effectiveFrom: 'asc' } })
}

export async function findSpecialtyAssignmentsForPair(clinicianId: string, specialtyId: string, db: DbClient = prisma) {
  return db.clinicianSpecialtyAssignment.findMany({ where: { clinicianId, specialtyId } })
}

export async function createSpecialtyAssignmentRecord(
  input: { clinicianId: string; specialtyId: string; effectiveFrom: Date; effectiveTo: Date | null },
  db: DbClient = prisma,
) {
  return db.clinicianSpecialtyAssignment.create({ data: input })
}

export async function closeSpecialtyAssignmentRecord(id: string, effectiveTo: Date, db: DbClient = prisma) {
  return db.clinicianSpecialtyAssignment.update({ where: { id }, data: { effectiveTo } })
}

// There is deliberately no delete function in this repository: an assignment is closed, never
// removed, so history stays reconstructable.
