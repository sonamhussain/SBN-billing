import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.1 — Prisma access for exception intakes. Claims, assessments, cases, timelines and traces are read through their
// owners (the service); here the only reads are the intake rows themselves, and the only write is the append-only
// intake, which the database refuses to update, delete or truncate.

// The one intake with this deterministic identity, if any.
export async function findIntakeByIdentity(identityKey: string, db: DbClient) {
  return db.exceptionIntakeRecord.findUnique({ where: { identityKey } })
}

// A Claim's intakes in database-recorded order, then id for a stable presentation only (never evidence causality).
export async function findIntakesOfClaim(claimId: string, db: DbClient) {
  return db.exceptionIntakeRecord.findMany({ where: { claimId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
}

export type IntakeRecord = Awaited<ReturnType<typeof findIntakesOfClaim>>[number]

export type NewIntake = {
  organizationId: string
  claimId: string
  contractVersion: string
  sourceKind: string
  sourceRecordId: string
  sourceContractVersion: string
  sourceFingerprintSha256: string | null
  exceptionReasonCode: string
  identityKey: string
  recordedByUserId: string
}

// The intake is written with an explicit column list that omits id, recorded_at and created_at, so the server and the
// database's own transaction time own them (the insert guard refuses any other). The row is then read back.
export async function insertIntake(data: NewIntake, db: DbClient): Promise<IntakeRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "operational_intake_records" ("id", "organization_id", "claim_id", "contract_version", "source_kind", "source_record_id", "source_contract_version", "source_fingerprint_sha256", "exception_reason_code", "identity_key", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sourceKind}, ${data.sourceRecordId}::uuid, ${data.sourceContractVersion}, ${data.sourceFingerprintSha256}, ${data.exceptionReasonCode}, ${data.identityKey}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionIntakeRecord.findUniqueOrThrow({ where: { id: inserted.id } })
}
