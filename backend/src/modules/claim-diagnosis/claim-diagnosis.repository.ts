import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.2 — Prisma access for ClaimDiagnoses. There is no delete function and the source and role are never
// updated: a ClaimDiagnosis is only re-positioned or marked removed, and the database refuses everything
// else. A role correction is a removal plus a new row.

// The owning organization only — nothing about the diagnosis is fetched for a caller not yet authorized.
export async function findClaimDiagnosisOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimDiagnosis.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}

// claimId is immutable, so this unlocked read only finds the lock target.
export async function findClaimDiagnosisLocation(id: string, db: DbClient) {
  return db.claimDiagnosis.findUnique({ where: { id }, select: { claimId: true } })
}

// §10 — the exact source DiagnosisCode is joined for display only.
const diagnosisInclude = { encounterDiagnosis: { select: { diagnosisCodeId: true, diagnosisCode: { select: { code: true, displayName: true } } } } } as const

export async function findClaimDiagnosisById(id: string, db: DbClient = prisma) {
  return db.claimDiagnosis.findUnique({ where: { id }, include: diagnosisInclude })
}

// Active diagnoses in Claim position order — never source UUID or Encounter order.
export async function findActiveClaimDiagnoses(claimId: string, db: DbClient = prisma) {
  return db.claimDiagnosis.findMany({ where: { claimId, removedAt: null }, orderBy: [{ sequence: 'asc' }], include: diagnosisInclude })
}

// The exact EncounterDiagnosis named by the client: its Encounter and organization only.
export async function findEncounterDiagnosisSource(id: string, db: DbClient) {
  const row = await db.encounterDiagnosis.findUnique({ where: { id }, select: { id: true, encounterId: true, encounter: { select: { patient: { select: { organizationId: true } } } } } })
  return row ? { id: row.id, encounterId: row.encounterId, organizationId: row.encounter.patient.organizationId } : null
}

export async function findActiveClaimDiagnosisForSource(claimId: string, encounterDiagnosisId: string, db: DbClient) {
  return db.claimDiagnosis.findFirst({ where: { claimId, encounterDiagnosisId, removedAt: null }, select: { id: true } })
}

export async function createClaimDiagnosisRecord(
  data: { claimId: string; encounterDiagnosisId: string; sequence: number; roleCode: string; claimDiagnosisContractVersion: string; createdByUserId: string },
  db: DbClient,
) {
  return db.claimDiagnosis.create({ data })
}

export async function setClaimDiagnosisSequence(id: string, sequence: number, db: DbClient) {
  return db.claimDiagnosis.update({ where: { id }, data: { sequence }, select: { id: true } })
}

// The database stamps removed_at with its own transaction time; the value sent here is replaced.
export async function markClaimDiagnosisRemoved(id: string, db: DbClient) {
  return db.claimDiagnosis.update({ where: { id }, data: { removedAt: new Date() }, select: { id: true, removedAt: true } })
}
