import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A7.1 — Prisma access for revenue source evidence. The frozen submission is READ from its A6.7 owner (identity,
// Claim and owning organization only — never its bytes or manifest here); the only write is the append-only
// registration, which the database refuses to update or delete.

// The frozen submission's Claim and owning organization (Submission -> Claim -> Encounter -> Patient ->
// Organization). Nothing else of the freeze is needed here.
export async function findSubmissionForRevenueEvidence(submissionId: string, db: DbClient) {
  const row = await db.claimFreeze.findUnique({
    where: { id: submissionId },
    select: { id: true, claimId: true, claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
  return row ? { id: row.id, claimId: row.claimId, organizationId: row.claim.encounter.patient.organizationId } : null
}

// The one registration with this stable identity, if any.
export async function findEvidenceByIdentity(identity: { claimSubmissionId: string; sourceKind: string; sourceReference: string; sourceVersion: string }, db: DbClient) {
  return db.revenueSourceEvidence.findUnique({ where: { claimSubmissionId_sourceKind_sourceReference_sourceVersion: identity } })
}

// A frozen submission's registrations in database-recorded order, then id for a stable presentation only.
export async function findEvidenceOfSubmission(claimSubmissionId: string, db: DbClient) {
  return db.revenueSourceEvidence.findMany({ where: { claimSubmissionId }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
}

export type RevenueSourceEvidenceRecord = Awaited<ReturnType<typeof findEvidenceOfSubmission>>[number]

export async function findEvidenceById(id: string, db: DbClient = prisma) {
  return db.revenueSourceEvidence.findUnique({ where: { id } })
}

export type NewRevenueSourceEvidence = {
  organizationId: string
  claimSubmissionId: string
  sourceKind: string
  sourceReference: string
  sourceVersion: string
  recordedByUserId: string
}

// The registration is written with an explicit column list that omits received_at, created_at and the source
// digest, so both instants take the database's own transaction time (the client never supplies an instant; the
// insert guard refuses one) and no digest is ever fabricated. The row is then read back through Prisma.
export async function insertRevenueSourceEvidence(data: NewRevenueSourceEvidence, db: DbClient): Promise<RevenueSourceEvidenceRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "revenue_source_evidence" ("id", "organization_id", "claim_submission_id", "source_kind", "source_reference", "source_version", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.organizationId}::uuid, ${data.claimSubmissionId}::uuid, ${data.sourceKind}, ${data.sourceReference}, ${data.sourceVersion}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.revenueSourceEvidence.findUniqueOrThrow({ where: { id: inserted.id } })
}

// The owning organization of a registration (stored, and held equal to its freeze's by the insert guard).
export async function findEvidenceOwnership(id: string, db: DbClient = prisma) {
  const row = await db.revenueSourceEvidence.findUnique({ where: { id }, select: { organizationId: true } })
  return row ? { organizationId: row.organizationId } : null
}
