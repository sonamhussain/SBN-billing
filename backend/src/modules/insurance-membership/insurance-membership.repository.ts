import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { MembershipPatch, MembershipWriteInput } from './insurance-membership.validation.ts'

// A4.3 — Prisma access only. No validation, authorization or audit decision lives here, and there
// is deliberately no delete function: a membership is corrected, never removed.

// ---- pre-authorization ownership (minimal selects) -------------------------------------------
// Authorization runs before the caller is known to be allowed to see anything. These lookups
// therefore select the owning organization and nothing else — no demographic column, and never a
// member or policy identifier.

export async function findPatientOwnership(patientId: string, db: DbClient = prisma) {
  return db.patient.findUnique({ where: { id: patientId }, select: { organizationId: true } })
}

export async function findMembershipOwnership(id: string, db: DbClient = prisma) {
  const row = await db.insuranceMembership.findUnique({ where: { id }, select: { patient: { select: { organizationId: true } } } })
  return row ? { organizationId: row.patient.organizationId } : null
}

// ---- commercial masters (ownership facts only) ----------------------------------------------

export async function findPayerOwnership(id: string, db: DbClient = prisma) {
  return db.payer.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findTpaOwnership(id: string, db: DbClient = prisma) {
  return db.tpa.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findNetworkOwnership(id: string, db: DbClient = prisma) {
  return db.network.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findInsuranceProductOwnership(id: string, db: DbClient = prisma) {
  return db.insuranceProduct.findUnique({ where: { id }, select: { organizationId: true, payerId: true } })
}

// ---- memberships -----------------------------------------------------------------------------

export async function createMembershipRecord(patientId: string, input: MembershipWriteInput, db: DbClient = prisma) {
  return db.insuranceMembership.create({ data: { patientId, ...input } })
}

export async function findMembershipById(id: string, db: DbClient = prisma) {
  return db.insuranceMembership.findUnique({ where: { id } })
}

export async function findMembershipsByPatientId(patientId: string, db: DbClient = prisma) {
  return db.insuranceMembership.findMany({ where: { patientId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

export async function updateMembershipRecord(id: string, patch: MembershipPatch, db: DbClient = prisma) {
  return db.insuranceMembership.update({ where: { id }, data: patch })
}
