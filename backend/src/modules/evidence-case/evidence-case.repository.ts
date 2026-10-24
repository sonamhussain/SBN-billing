import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { CaseItem } from './evidence-case.types.ts'

// A7.4 — Prisma access for case snapshots. The frozen submission, its sources, classifications and readiness results
// are read through their owners (the service); the only writes are the append-only header and its entries, which
// the database refuses to update, delete or truncate and checks for completeness at commit.

// The one snapshot with this stable identity, if any, with its entries in ordinal order.
export async function findCaseByIdentity(claimSubmissionId: string, contractVersion: string, db: DbClient) {
  return db.evidenceCaseSnapshot.findUnique({
    where: { claimSubmissionId_contractVersion: { claimSubmissionId, contractVersion } },
    include: { entries: { orderBy: { ordinal: 'asc' } } },
  })
}

export type CaseRecord = NonNullable<Awaited<ReturnType<typeof findCaseByIdentity>>>

// A submission's snapshot headers in database-recorded order, then id for a stable presentation only.
export async function findCasesOfSubmission(claimSubmissionId: string, db: DbClient) {
  return db.evidenceCaseSnapshot.findMany({ where: { claimSubmissionId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
}

export type CaseHeaderRecord = Awaited<ReturnType<typeof findCasesOfSubmission>>[number]

export async function findCaseById(id: string, db: DbClient = prisma) {
  return db.evidenceCaseSnapshot.findUnique({ where: { id }, include: { entries: { orderBy: { ordinal: 'asc' } } } })
}

export type NewCase = {
  organizationId: string
  claimSubmissionId: string
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
  recordedByUserId: string
}

// The header is written with an explicit column list that omits recorded_at and created_at, so both take the
// database's own transaction time (the insert guard refuses any other).
export async function insertCaseHeader(data: NewCase, db: DbClient): Promise<string> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "evidence_case_snapshots" ("id", "organization_id", "claim_submission_id", "contract_version", "assembly_code", "source_count", "classified_count", "readiness_count", "item_count", "manifest_sha256", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.organizationId}::uuid, ${data.claimSubmissionId}::uuid, ${data.contractVersion}, ${data.assemblyCode}, ${data.sourceCount}, ${data.classifiedCount}, ${data.readinessCount}, ${data.itemCount}, ${data.manifestSha256}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return inserted.id
}

// Every entry of the header, in ordinal order, on the same transaction (the guard refuses any later one).
export async function insertCaseEntries(caseId: string, items: CaseItem[], db: DbClient) {
  for (const item of items) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "evidence_case_entries" ("id", "assembly_id", "ordinal", "source_evidence_id", "classification_id", "readiness_id", "item_reason_code")
      VALUES (gen_random_uuid(), ${caseId}::uuid, ${item.ordinal}, ${item.sourceEvidenceId}::uuid, ${item.classificationId}::uuid, ${item.readinessId}::uuid, ${item.itemReasonCode})`)
  }
}

// The owning organization of a snapshot (stored, and held equal to its frozen submission's by the insert guard).
export async function findCaseOwnership(id: string, db: DbClient = prisma) {
  const row = await db.evidenceCaseSnapshot.findUnique({ where: { id }, select: { organizationId: true } })
  return row ? { organizationId: row.organizationId } : null
}
