import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.2 — Prisma access for ClaimLines, their immutable source rows and their diagnosis pointers. There is
// no delete function and no update of a source row: a line or pointer is only ever re-positioned or
// marked removed, and the database refuses everything else. Encounter, readiness and handoff truth is
// never re-implemented here.

// ---- the Claim the structure hangs under ---------------------------------------------------------

// The Claim's own binding and organization, read on the caller's (locked) transaction.
export async function findClaimForStructure(claimId: string, db: DbClient) {
  return db.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      encounterId: true,
      preClaimReadinessAssessmentId: true,
      claimContractVersion: true,
      handoffSchemaVersion: true,
      encounter: { select: { patient: { select: { organizationId: true } } } },
    },
  })
}

// ---- ownership (routes) --------------------------------------------------------------------------

// The owning organization only — nothing about the line is fetched for a caller not yet authorized.
export async function findClaimLineOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimLine.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}

// claimId is immutable, so this unlocked read only finds the lock target; every decision is made on a
// re-read taken while holding the Claim lock.
export async function findClaimLineLocation(id: string, db: DbClient) {
  return db.claimLine.findUnique({ where: { id }, select: { claimId: true } })
}

// ---- reads ---------------------------------------------------------------------------------------

// §9 — the exact source activity and its ordered modifiers are joined for display; the active pointers
// carry their diagnosis position so the derived pointer order is ClaimDiagnosis.sequence.
const lineInclude = {
  sources: {
    select: {
      encounterActivity: {
        select: {
          id: true,
          serviceId: true,
          procedureCodeId: true,
          quantity: true,
          unitCode: true,
          modifiers: { orderBy: { sequence: 'asc' }, select: { code: true } },
        },
      },
    },
  },
  diagnosisPointers: { where: { removedAt: null }, select: { claimDiagnosisId: true, claimDiagnosis: { select: { sequence: true } } } },
} as const

export async function findClaimLineById(id: string, db: DbClient = prisma) {
  return db.claimLine.findUnique({ where: { id }, include: lineInclude })
}

// Active lines in Claim position order — never source UUID order.
export async function findActiveClaimLines(claimId: string, db: DbClient = prisma) {
  return db.claimLine.findMany({ where: { claimId, removedAt: null }, orderBy: [{ sequence: 'asc' }], include: lineInclude })
}

// ---- source lookups ------------------------------------------------------------------------------

// The exact EncounterActivity named by the client: its Encounter and organization only.
export async function findEncounterActivitySource(id: string, db: DbClient) {
  const row = await db.encounterActivity.findUnique({ where: { id }, select: { id: true, encounterId: true, encounter: { select: { patient: { select: { organizationId: true } } } } } })
  return row ? { id: row.id, encounterId: row.encounterId, organizationId: row.encounter.patient.organizationId } : null
}

// §7 — is this EncounterActivity already the source of an ACTIVE line of this Claim?
export async function findActiveLineForSource(claimId: string, encounterActivityId: string, db: DbClient) {
  return db.claimLineSourceActivity.findFirst({ where: { encounterActivityId, claimLine: { claimId, removedAt: null } }, select: { claimLineId: true } })
}

// ---- writes --------------------------------------------------------------------------------------

export async function createClaimLineRecord(data: { claimId: string; sequence: number; claimLineContractVersion: string; createdByUserId: string }, db: DbClient) {
  return db.claimLine.create({ data })
}

export async function createClaimLineSource(data: { claimLineId: string; encounterActivityId: string }, db: DbClient) {
  return db.claimLineSourceActivity.create({ data })
}

export async function setClaimLineSequence(id: string, sequence: number, db: DbClient) {
  return db.claimLine.update({ where: { id }, data: { sequence }, select: { id: true } })
}

// The database stamps removed_at with its own transaction time; the value sent here is replaced.
export async function markClaimLineRemoved(id: string, db: DbClient) {
  return db.claimLine.update({ where: { id }, data: { removedAt: new Date() }, select: { id: true, removedAt: true } })
}

// ---- pointers ------------------------------------------------------------------------------------

export async function findActivePointersForLine(claimLineId: string, db: DbClient) {
  return db.claimLineDiagnosisPointer.findMany({ where: { claimLineId, removedAt: null }, select: { id: true, claimDiagnosisId: true } })
}

export async function findActivePointersForDiagnosis(claimDiagnosisId: string, db: DbClient) {
  return db.claimLineDiagnosisPointer.findMany({ where: { claimDiagnosisId, removedAt: null }, select: { id: true } })
}

// The ClaimDiagnosis named in a pointer request: its Claim, activity and organization only.
export async function findClaimDiagnosisTargets(ids: string[], db: DbClient) {
  const rows = await db.claimDiagnosis.findMany({
    where: { id: { in: ids } },
    select: { id: true, claimId: true, removedAt: true, claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
  return rows.map((row) => ({ id: row.id, claimId: row.claimId, removedAt: row.removedAt, organizationId: row.claim.encounter.patient.organizationId }))
}

export async function createPointers(claimLineId: string, claimDiagnosisIds: string[], createdByUserId: string, db: DbClient) {
  if (claimDiagnosisIds.length === 0) return
  await db.claimLineDiagnosisPointer.createMany({ data: claimDiagnosisIds.map((claimDiagnosisId) => ({ claimLineId, claimDiagnosisId, createdByUserId })) })
}

// One-way: the database stamps removed_at once and refuses any later change.
export async function markPointersRemoved(ids: string[], db: DbClient) {
  if (ids.length === 0) return
  await db.claimLineDiagnosisPointer.updateMany({ where: { id: { in: ids }, removedAt: null }, data: { removedAt: new Date() } })
}
