import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.4 — Prisma access for claim draft assembly. Everything the draft is built from is READ from its owner
// (A6.1 Claim and its bound A5 chain, A6.2 structure, A6.3 pricing run); the only writes are the append-only
// assessment and its findings, which the database refuses to update or delete.

// ---- the Claim and its bound lineage -------------------------------------------------------------

// The Claim's own binding, organization and the exact ValidationRun context its readiness assessment
// recorded — read from the stored chain, never re-resolved.
export async function findClaimLineage(claimId: string, db: DbClient) {
  return db.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      encounterId: true,
      preClaimReadinessAssessmentId: true,
      claimContractVersion: true,
      handoffSchemaVersion: true,
      encounter: { select: { patient: { select: { organizationId: true } } } },
      preClaimReadinessAssessment: {
        select: {
          validationRun: {
            select: {
              id: true,
              serviceDate: true,
              facilityRegulatoryProfileId: true,
              providerContractId: true,
              tariffScheduleId: true,
              tariffScheduleVersionId: true,
            },
          },
        },
      },
    },
  })
}

// ---- the A6.2 structure --------------------------------------------------------------------------

// Active lines in Claim order with every source row and its exact facts (modifiers in stored order).
export async function findActiveDraftLines(claimId: string, db: DbClient) {
  return db.claimLine.findMany({
    where: { claimId, removedAt: null },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      sequence: true,
      sources: {
        select: {
          encounterActivity: {
            select: {
              id: true,
              encounterId: true,
              serviceId: true,
              procedureCodeId: true,
              quantity: true,
              unitCode: true,
              removedAt: true,
              modifiers: { orderBy: { sequence: 'asc' }, select: { code: true } },
            },
          },
        },
      },
    },
  })
}

// Active diagnoses in Claim order, with their source's Encounter and removal only — no code or text.
export async function findActiveDraftDiagnoses(claimId: string, db: DbClient) {
  return db.claimDiagnosis.findMany({
    where: { claimId, removedAt: null },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    select: { id: true, sequence: true, encounterDiagnosisId: true, roleCode: true, encounterDiagnosis: { select: { encounterId: true, removedAt: true } } },
  })
}

// Every active pointer of an active line of this Claim, with the Claim and removal of the diagnosis it
// names, so a cross-Claim or removed target is visible instead of filtered away.
export async function findActiveDraftPointers(claimId: string, db: DbClient) {
  return db.claimLineDiagnosisPointer.findMany({
    where: { removedAt: null, claimLine: { claimId, removedAt: null } },
    orderBy: [{ claimLineId: 'asc' }, { claimDiagnosisId: 'asc' }, { id: 'asc' }],
    select: { id: true, claimLineId: true, claimDiagnosisId: true, claimDiagnosis: { select: { claimId: true, removedAt: true } } },
  })
}

// ---- the A6.3 pricing run ------------------------------------------------------------------------

export async function findDraftPricingRun(id: string, db: DbClient) {
  return db.claimPricingRun.findUnique({ where: { id }, include: { lineResults: { orderBy: [{ lineSequenceAtEvaluation: 'asc' }, { claimLineId: 'asc' }] } } })
}

// ---- assessments ---------------------------------------------------------------------------------

export async function createAssessmentRecord(data: Prisma.ClaimDraftAssessmentUncheckedCreateInput, db: DbClient) {
  return db.claimDraftAssessment.create({ data })
}

export async function createFindingRecords(data: Prisma.ClaimDraftFindingUncheckedCreateInput[], db: DbClient) {
  if (data.length === 0) return
  await db.claimDraftFinding.createMany({ data })
}

const withFindings = { findings: { orderBy: { ordinal: 'asc' } } } as const

export async function findAssessmentById(id: string, db: DbClient = prisma) {
  return db.claimDraftAssessment.findUnique({ where: { id }, include: withFindings })
}

// History order for presentation only (evaluatedAt, createdAt newest first, then id) — never a "current"
// assessment.
export async function findAssessmentsOfClaim(claimId: string, db: DbClient = prisma) {
  return db.claimDraftAssessment.findMany({ where: { claimId }, orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }] })
}

// The owning organization of an assessment, through its Claim.
export async function findAssessmentOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimDraftAssessment.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}
