import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A4.5 §14 — database access only. No permission or business decision lives here, and there is
// deliberately no delete function: a diagnosis link is marked removed, never deleted. Encounter
// ownership is NOT re-implemented here — callers reuse A4.4's findEncounterOwnership.

const withCode = { diagnosisCode: { select: { code: true, displayName: true } } } as const

// Pre-authorization ownership: the owning organization ONLY — no diagnosis, encounter or patient
// field is fetched for a caller who is not yet authorized.
export async function findEncounterDiagnosisOwnership(id: string, db: DbClient = prisma) {
  const row = await db.encounterDiagnosis.findUnique({
    where: { id },
    select: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
  return row ? { organizationId: row.encounter.patient.organizationId } : null
}

export async function findDiagnosisCodeOwnership(id: string, db: DbClient = prisma) {
  return db.diagnosisCode.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findActiveEncounterDiagnoses(encounterId: string, db: DbClient = prisma) {
  return db.encounterDiagnosis.findMany({
    where: { encounterId, removedAt: null },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    include: withCode,
  })
}

export async function findEncounterDiagnosisById(id: string, db: DbClient = prisma) {
  return db.encounterDiagnosis.findUnique({ where: { id } })
}

export async function createEncounterDiagnosisRecord(data: { encounterId: string; diagnosisCodeId: string; sequence: number }, db: DbClient) {
  return db.encounterDiagnosis.create({ data: { ...data, removedAt: null }, include: withCode })
}

export async function setEncounterDiagnosisSequence(id: string, sequence: number, db: DbClient) {
  return db.encounterDiagnosis.update({ where: { id }, data: { sequence } })
}

export async function markEncounterDiagnosisRemoved(id: string, removedAt: Date, db: DbClient) {
  return db.encounterDiagnosis.update({ where: { id }, data: { removedAt } })
}
