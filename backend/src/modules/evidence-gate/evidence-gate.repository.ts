import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A7.3 — Prisma access for internal readiness results. The A7.2 classification, its A7.1 source and the source's
// frozen submission are READ (identifiers, codes, the stored fingerprint and organizations only — never raw
// evidence, payload bytes or patient data); the only write is the append-only result, which the database refuses
// to update, delete or truncate.

// One classification as stored, the source it belongs to, that source's frozen submission and Claim, and the
// organization that owns the submission. LEFT JOINs on purpose: a missing link must reach the service as a missing
// value (a provenance conflict), never as a silently absent row.
export async function findClassificationForGate(classificationId: string, db: DbClient) {
  const rows = await db.$queryRaw<
    {
      classification_id: string
      classification_organization_id: string
      source_evidence_id: string
      contract_version: string
      classification_code: string
      normalization_outcome: string
      reason_code: string
      source_fingerprint_sha256: string
      source_id: string | null
      source_organization_id: string | null
      claim_submission_id: string | null
      claim_id: string | null
      submission_organization_id: string | null
    }[]
  >`
    SELECT c."id"::text AS "classification_id", c."organization_id"::text AS "classification_organization_id",
           c."source_evidence_id"::text AS "source_evidence_id", c."contract_version", c."classification_code",
           c."normalization_outcome", c."reason_code", c."source_fingerprint_sha256",
           r."id"::text AS "source_id", r."organization_id"::text AS "source_organization_id",
           r."claim_submission_id"::text AS "claim_submission_id", f."claim_id"::text AS "claim_id",
           p."organization_id"::text AS "submission_organization_id"
    FROM "source_evidence_classifications" c
    LEFT JOIN "revenue_source_evidence" r ON r."id" = c."source_evidence_id"
    LEFT JOIN "claim_freezes" f ON f."id" = r."claim_submission_id"
    LEFT JOIN "claims" k ON k."id" = f."claim_id"
    LEFT JOIN "encounters" e ON e."id" = k."encounter_id"
    LEFT JOIN "patients" p ON p."id" = e."patient_id"
    WHERE c."id" = ${classificationId}::uuid`
  const row = rows[0]
  if (!row) return null
  return {
    classificationId: row.classification_id,
    organizationId: row.classification_organization_id,
    sourceEvidenceId: row.source_evidence_id,
    contractVersion: row.contract_version,
    classificationCode: row.classification_code,
    normalizationOutcome: row.normalization_outcome,
    reasonCode: row.reason_code,
    sourceFingerprintSha256: row.source_fingerprint_sha256,
    sourceId: row.source_id,
    sourceOrganizationId: row.source_organization_id,
    claimSubmissionId: row.claim_submission_id,
    claimId: row.claim_id,
    submissionOrganizationId: row.submission_organization_id,
  }
}

export type ClassificationForGate = NonNullable<Awaited<ReturnType<typeof findClassificationForGate>>>

// The one result with this stable identity, if any.
export async function findReadinessByIdentity(classificationId: string, contractVersion: string, db: DbClient) {
  return db.evidenceGateResult.findUnique({ where: { classificationId_contractVersion: { classificationId, contractVersion } } })
}

// A classification's results in database-recorded order, then id for a stable presentation only.
export async function findReadinessOfClassification(classificationId: string, db: DbClient) {
  return db.evidenceGateResult.findMany({ where: { classificationId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
}

export type ReadinessRecord = Awaited<ReturnType<typeof findReadinessOfClassification>>[number]

export async function findReadinessById(id: string, db: DbClient = prisma) {
  return db.evidenceGateResult.findUnique({ where: { id } })
}

export type NewReadiness = {
  organizationId: string
  sourceEvidenceId: string
  classificationId: string
  contractVersion: string
  readinessCode: string
  reasonCode: string
  classificationFingerprintSha256: string
  recordedByUserId: string
}

// The result is written with an explicit column list that omits recorded_at and created_at, so both take the
// database's own transaction time (the insert guard refuses any other). The row is then read back.
export async function insertReadiness(data: NewReadiness, db: DbClient): Promise<ReadinessRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "evidence_gate_results" ("id", "organization_id", "source_evidence_id", "classification_id", "contract_version", "readiness_code", "reason_code", "classification_fingerprint_sha256", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.organizationId}::uuid, ${data.sourceEvidenceId}::uuid, ${data.classificationId}::uuid, ${data.contractVersion}, ${data.readinessCode}, ${data.reasonCode}, ${data.classificationFingerprintSha256}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.evidenceGateResult.findUniqueOrThrow({ where: { id: inserted.id } })
}

// The owning organization of a result (stored, and held equal to its classification's by the insert guard).
export async function findReadinessOwnership(id: string, db: DbClient = prisma) {
  const row = await db.evidenceGateResult.findUnique({ where: { id }, select: { organizationId: true } })
  return row ? { organizationId: row.organizationId } : null
}
