import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A4.6 §19 — database access only. No permission or business decision lives here, and there is
// deliberately no delete or update-in-place function: an activity is marked removed, never deleted
// or patched, and its modifier children are only ever inserted. Encounter ownership is NOT
// re-implemented here — callers reuse A4.4's findEncounterOwnership.

const withModifiers = { modifiers: { orderBy: { sequence: 'asc' }, select: { sequence: true, code: true } } } as const

// Pre-authorization ownership: the owning organization ONLY — no activity, encounter or patient
// field is fetched for a caller who is not yet authorized.
export async function findEncounterActivityOwnership(id: string, db: DbClient = prisma) {
  const row = await db.encounterActivity.findUnique({
    where: { id },
    select: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
  return row ? { organizationId: row.encounter.patient.organizationId } : null
}

export async function findServiceOwnership(id: string, db: DbClient = prisma) {
  return db.service.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findProcedureCodeOwnership(id: string, db: DbClient = prisma) {
  return db.procedureCode.findUnique({ where: { id }, select: { organizationId: true } })
}

export async function findEncounterActivityById(id: string, db: DbClient = prisma) {
  return db.encounterActivity.findUnique({ where: { id }, include: withModifiers })
}

// Deterministic DISPLAY order only (createdAt, then id) — never a ClaimLine order.
export async function findActiveEncounterActivities(encounterId: string, db: DbClient = prisma) {
  return db.encounterActivity.findMany({
    where: { encounterId, removedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: withModifiers,
  })
}

export async function createEncounterActivityRecord(
  data: { encounterId: string; serviceId: string | null; procedureCodeId: string | null; quantity: Prisma.Decimal; unitCode: string | null },
  db: DbClient,
) {
  return db.encounterActivity.create({ data: { ...data, removedAt: null } })
}

// Modifier rows in the supplied order: sequence 1..N.
export async function createEncounterActivityModifiers(encounterActivityId: string, modifierCodes: string[], db: DbClient) {
  if (modifierCodes.length === 0) return
  await db.encounterActivityModifier.createMany({
    data: modifierCodes.map((code, index) => ({ encounterActivityId, sequence: index + 1, code })),
  })
}

export async function markEncounterActivityRemoved(id: string, removedAt: Date, db: DbClient) {
  return db.encounterActivity.update({ where: { id }, data: { removedAt }, include: withModifiers })
}
