import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A5.9 — Prisma access for readiness assessments. Runs and findings are read through A5.7's own
// repository wherever their full rows are needed; here they are read only for ownership, the
// validator version and outcomes. There is no update or delete function: the database refuses both.

// ---- ownership (routes) ------------------------------------------------------------------------

export async function findAssessmentOwnership(assessmentId: string, db: DbClient = prisma) {
  return db.preClaimReadinessAssessment.findUnique({
    where: { id: assessmentId },
    select: { validationRun: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
}

// ---- assessment creation -----------------------------------------------------------------------

export async function findRunForAssessment(runId: string, db: DbClient) {
  return db.validationRun.findUnique({
    where: { id: runId },
    select: { id: true, validatorVersion: true, encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
}

// §3 — outcomes, codes and sequence only. The message and field path are never read for readiness.
export async function findFindingOutcomes(runId: string, db: DbClient = prisma) {
  return db.validationFinding.findMany({
    where: { validationRunId: runId },
    select: { id: true, sequence: true, outcome: true, findingCode: true },
    orderBy: [{ sequence: 'asc' }],
  })
}

export async function findAssessmentForRunAndPolicy(runId: string, readinessPolicyVersion: string, db: DbClient) {
  return db.preClaimReadinessAssessment.findUnique({
    where: { validationRunId_readinessPolicyVersion: { validationRunId: runId, readinessPolicyVersion } },
    select: { id: true },
  })
}

export async function createAssessmentRecord(data: Prisma.PreClaimReadinessAssessmentUncheckedCreateInput, db: DbClient) {
  return db.preClaimReadinessAssessment.create({ data })
}

// ---- reads -------------------------------------------------------------------------------------

// §15 — newest assessment first, then newest row, then id: a fixed order, never a "current" label.
export async function findAssessmentsForEncounter(encounterId: string, db: DbClient = prisma) {
  return db.preClaimReadinessAssessment.findMany({
    where: { validationRun: { encounterId } },
    orderBy: [{ assessedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  })
}

export async function findAssessmentById(assessmentId: string, db: DbClient = prisma) {
  return db.preClaimReadinessAssessment.findUnique({
    where: { id: assessmentId },
    include: { validationRun: { select: { validatorVersion: true } } },
  })
}

// §11 — whether any other run of the same Encounter is later on (evaluatedAt, createdAt), or sits at
// exactly the same pair. Compared in the database so microseconds count; parameterized, read-only.
export async function findRecencyRelations(runId: string, db: DbClient): Promise<{ anyNewer: boolean; anyTied: boolean }> {
  const rows = await db.$queryRaw<{ any_newer: boolean; any_tied: boolean }[]>`
    SELECT
      coalesce(bool_or(other.evaluated_at > selected.evaluated_at
        OR (other.evaluated_at = selected.evaluated_at AND other.created_at > selected.created_at)), false) AS any_newer,
      coalesce(bool_or(other.evaluated_at = selected.evaluated_at AND other.created_at = selected.created_at), false) AS any_tied
    FROM validation_runs selected
    JOIN validation_runs other ON other.encounter_id = selected.encounter_id AND other.id <> selected.id
    WHERE selected.id = ${runId}::uuid`
  return { anyNewer: rows[0]?.any_newer === true, anyTied: rows[0]?.any_tied === true }
}
