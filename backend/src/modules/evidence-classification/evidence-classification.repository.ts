import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { SourceFacts } from './evidence-classification.types.ts'

// A7.2 — Prisma access for evidence classifications. The A7.1 source record and its frozen submission are READ
// (identifiers, codes and the database instant only — never raw evidence, payload bytes or patient data); the
// only write is the append-only classification, which the database refuses to update, delete or truncate.

// The source record's own facts, its frozen submission's Claim and that submission's owning organization. The
// instant is read at the database's own microsecond precision (as integer epoch microseconds), never rounded
// through a JavaScript Date, so the fingerprint is exactly the one the database guard recomputes.
export async function findSourceForClassification(sourceEvidenceId: string, db: DbClient) {
  const rows = await db.$queryRaw<
    {
      id: string
      organization_id: string
      claim_submission_id: string
      claim_id: string | null
      submission_organization_id: string | null
      source_kind: string
      source_reference: string
      source_version: string
      source_digest_sha256: string | null
      received_us: string
    }[]
  >`
    SELECT r."id"::text AS "id", r."organization_id"::text AS "organization_id", r."claim_submission_id"::text AS "claim_submission_id",
           f."claim_id"::text AS "claim_id", p."organization_id"::text AS "submission_organization_id",
           r."source_kind", r."source_reference", r."source_version", r."source_digest_sha256",
           ((extract(epoch FROM r."received_at") * 1000000)::bigint)::text AS "received_us"
    FROM "revenue_source_evidence" r
    LEFT JOIN "claim_freezes" f ON f."id" = r."claim_submission_id"
    LEFT JOIN "claims" c ON c."id" = f."claim_id"
    LEFT JOIN "encounters" e ON e."id" = c."encounter_id"
    LEFT JOIN "patients" p ON p."id" = e."patient_id"
    WHERE r."id" = ${sourceEvidenceId}::uuid`
  const row = rows[0]
  if (!row) return null
  const facts: SourceFacts = {
    sourceEvidenceId: row.id,
    organizationId: row.organization_id,
    claimSubmissionId: row.claim_submission_id,
    submissionOrganizationId: row.submission_organization_id,
    sourceKind: row.source_kind,
    sourceReference: row.source_reference,
    sourceVersion: row.source_version,
    sourceDigestSha256: row.source_digest_sha256,
    receivedAtMicros: row.received_us,
  }
  return { claimId: row.claim_id, facts }
}

// The one classification with this stable identity, if any.
export async function findClassificationByIdentity(sourceEvidenceId: string, contractVersion: string, db: DbClient) {
  return db.sourceEvidenceClassification.findUnique({ where: { sourceEvidenceId_contractVersion: { sourceEvidenceId, contractVersion } } })
}

// A source record's classifications in database-recorded order, then id for a stable presentation only.
export async function findClassificationsOfSource(sourceEvidenceId: string, db: DbClient) {
  return db.sourceEvidenceClassification.findMany({ where: { sourceEvidenceId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
}

export type EvidenceClassificationRecord = Awaited<ReturnType<typeof findClassificationsOfSource>>[number]

export async function findClassificationById(id: string, db: DbClient = prisma) {
  return db.sourceEvidenceClassification.findUnique({ where: { id } })
}

export type NewEvidenceClassification = {
  organizationId: string
  sourceEvidenceId: string
  contractVersion: string
  classificationCode: string
  normalizationOutcome: string
  reasonCode: string
  sourceFingerprintSha256: string
  recordedByUserId: string
}

// The classification is written with an explicit column list that omits recorded_at and created_at, so both
// take the database's own transaction time (the insert guard refuses any other). The row is then read back.
export async function insertClassification(data: NewEvidenceClassification, db: DbClient): Promise<EvidenceClassificationRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "source_evidence_classifications" ("id", "organization_id", "source_evidence_id", "contract_version", "classification_code", "normalization_outcome", "reason_code", "source_fingerprint_sha256", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.organizationId}::uuid, ${data.sourceEvidenceId}::uuid, ${data.contractVersion}, ${data.classificationCode}, ${data.normalizationOutcome}, ${data.reasonCode}, ${data.sourceFingerprintSha256}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: inserted.id } })
}

// The owning organization of a classification (stored, and held equal to its source's by the insert guard).
export async function findClassificationOwnership(id: string, db: DbClient = prisma) {
  const row = await db.sourceEvidenceClassification.findUnique({ where: { id }, select: { organizationId: true } })
  return row ? { organizationId: row.organizationId } : null
}
