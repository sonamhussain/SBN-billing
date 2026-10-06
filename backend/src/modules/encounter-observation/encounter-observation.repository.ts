import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { ObservationColumns } from './encounter-observation.types.ts'

// A4.7 §21 — database access only. No permission or business decision lives here, and there is
// deliberately no delete or update-in-place function: an observation is marked removed, never
// deleted or patched. Encounter ownership and the activity reader are NOT re-implemented here —
// callers reuse A4.4's findEncounterOwnership and A4.6's findEncounterActivityById.

// Each row is read with its anchored activity's own encounterId, so readers can verify the anchor.
const withAnchor = { encounterActivity: { select: { encounterId: true } } } as const

// Pre-authorization ownership: the owning organization ONLY — no fact, value, encounter or patient
// field is fetched for a caller who is not yet authorized.
export async function findEncounterObservationOwnership(id: string, db: DbClient = prisma) {
  const row = await db.encounterObservation.findUnique({
    where: { id },
    select: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
  return row ? { organizationId: row.encounter.patient.organizationId } : null
}

export async function findEncounterObservationById(id: string, db: DbClient = prisma) {
  return db.encounterObservation.findUnique({ where: { id }, include: withAnchor })
}

// Deterministic DISPLAY order only (createdAt, then id) — never clinical precedence or a ClaimLine order.
export async function findActiveEncounterObservations(encounterId: string, db: DbClient = prisma) {
  return db.encounterObservation.findMany({
    where: { encounterId, removedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: withAnchor,
  })
}

// Used by the A4.6 activity-removal dependency guard (§17).
export async function findActiveObservationCountForActivity(encounterActivityId: string, db: DbClient = prisma) {
  return db.encounterObservation.count({ where: { encounterActivityId, removedAt: null } })
}

export async function createEncounterObservationRecord(data: ObservationColumns & { encounterId: string; encounterActivityId: string | null }, db: DbClient) {
  return db.encounterObservation.create({ data: { ...data, removedAt: null }, include: withAnchor })
}

export async function markEncounterObservationRemoved(id: string, removedAt: Date, db: DbClient) {
  return db.encounterObservation.update({ where: { id }, data: { removedAt }, include: withAnchor })
}
