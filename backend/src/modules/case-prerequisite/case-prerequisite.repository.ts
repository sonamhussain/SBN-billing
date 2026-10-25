import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A7.5 — Prisma access for closure-prerequisite assessments. The A7.4 case and its entries are read through the A7.4
// owner, the linked readiness through the A7.3 owner (the service); here only the lock identity of a case is READ
// (identifiers and organizations only — never evidence, payload bytes or patient data), and the only write is the
// append-only assessment, which the database refuses to update, delete or truncate.

// One case snapshot, its frozen submission, that submission's Claim and the organization that owns it — the lock
// identity (case -> freeze -> Claim). LEFT JOINs on purpose: a missing link must reach the service as a missing value
// (a provenance conflict), never as a silently absent row.
export async function findCaseForPrerequisite(caseId: string, db: DbClient) {
  const rows = await db.$queryRaw<
    {
      case_id: string
      case_organization_id: string
      claim_submission_id: string
      claim_id: string | null
      submission_organization_id: string | null
    }[]
  >`
    SELECT h."id"::text AS "case_id", h."organization_id"::text AS "case_organization_id",
           h."claim_submission_id"::text AS "claim_submission_id", f."claim_id"::text AS "claim_id",
           p."organization_id"::text AS "submission_organization_id"
    FROM "evidence_case_snapshots" h
    LEFT JOIN "claim_freezes" f ON f."id" = h."claim_submission_id"
    LEFT JOIN "claims" k ON k."id" = f."claim_id"
    LEFT JOIN "encounters" e ON e."id" = k."encounter_id"
    LEFT JOIN "patients" p ON p."id" = e."patient_id"
    WHERE h."id" = ${caseId}::uuid`
  const row = rows[0]
  if (!row) return null
  return {
    caseId: row.case_id,
    organizationId: row.case_organization_id,
    claimSubmissionId: row.claim_submission_id,
    claimId: row.claim_id,
    submissionOrganizationId: row.submission_organization_id,
  }
}

export type CaseForPrerequisite = NonNullable<Awaited<ReturnType<typeof findCaseForPrerequisite>>>

// The one assessment with this stable identity, if any.
export async function findAssessmentByIdentity(evidenceCaseId: string, contractVersion: string, db: DbClient) {
  return db.evidencePrereqResult.findUnique({ where: { evidenceCaseId_contractVersion: { evidenceCaseId, contractVersion } } })
}

// A case's assessments in database-recorded order, then id for a stable presentation only.
export async function findAssessmentsOfCase(evidenceCaseId: string, db: DbClient) {
  return db.evidencePrereqResult.findMany({ where: { evidenceCaseId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
}

export type AssessmentRecord = Awaited<ReturnType<typeof findAssessmentsOfCase>>[number]

export async function findAssessmentById(id: string, db: DbClient = prisma) {
  return db.evidencePrereqResult.findUnique({ where: { id } })
}

export type NewAssessment = {
  organizationId: string
  evidenceCaseId: string
  contractVersion: string
  assessmentCode: string
  basisCode: string
  caseManifestSha256: string
  recordedByUserId: string
}

// The assessment is written with an explicit column list that omits recorded_at and created_at, so both take the
// database's own transaction time (the insert guard refuses any other). The row is then read back.
export async function insertAssessment(data: NewAssessment, db: DbClient): Promise<AssessmentRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "evidence_prereq_results" ("id", "organization_id", "evidence_case_id", "contract_version", "assessment_code", "basis_code", "case_manifest_sha256", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.organizationId}::uuid, ${data.evidenceCaseId}::uuid, ${data.contractVersion}, ${data.assessmentCode}, ${data.basisCode}, ${data.caseManifestSha256}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.evidencePrereqResult.findUniqueOrThrow({ where: { id: inserted.id } })
}

// The owning organization of an assessment (stored, and held equal to its case's by the insert guard).
export async function findAssessmentOwnership(id: string, db: DbClient = prisma) {
  const row = await db.evidencePrereqResult.findUnique({ where: { id }, select: { organizationId: true } })
  return row ? { organizationId: row.organizationId } : null
}
