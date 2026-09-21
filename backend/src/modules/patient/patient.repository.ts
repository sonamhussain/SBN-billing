import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { PatientPatch, PatientWriteInput } from './patient.validation.ts'

// A4.1 — Prisma access only. No validation, no authorization and no audit decision lives here.

export async function createPatientRecord(organizationId: string, input: PatientWriteInput, db: DbClient = prisma) {
  return db.patient.create({ data: { organizationId, ...input } })
}

export async function findPatientById(id: string, db: DbClient = prisma) {
  return db.patient.findUnique({ where: { id } })
}

export async function findPatientsByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.patient.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } })
}

export async function updatePatientRecord(id: string, patch: PatientPatch, db: DbClient = prisma) {
  return db.patient.update({ where: { id }, data: patch })
}
