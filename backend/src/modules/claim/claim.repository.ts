import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.1 — Prisma access for Claims. There is no update or delete function: the identity is immutable
// and the database refuses both. The bound assessment is read only for its Encounter, its organization
// and the derived source metadata; A5.9 owns every readiness decision.

// ---- ownership (routes) ------------------------------------------------------------------------

export async function findClaimOwnership(claimId: string, db: DbClient = prisma) {
  return db.claim.findUnique({ where: { id: claimId }, select: { encounter: { select: { patient: { select: { organizationId: true } } } } } })
}

// ---- creation ----------------------------------------------------------------------------------

// The assessment's own chain: which Encounter its run belongs to, and that Encounter's organization.
export async function findAssessmentBinding(assessmentId: string, db: DbClient) {
  return db.preClaimReadinessAssessment.findUnique({
    where: { id: assessmentId },
    select: { validationRun: { select: { encounterId: true, encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
}

export async function findClaimForAssessment(assessmentId: string, db: DbClient) {
  return db.claim.findUnique({ where: { preClaimReadinessAssessmentId: assessmentId }, select: { id: true } })
}

export async function createClaimRecord(data: Prisma.ClaimUncheckedCreateInput, db: DbClient) {
  return db.claim.create({ data })
}

// ---- reads -------------------------------------------------------------------------------------

const withSource = { preClaimReadinessAssessment: { select: { validationRunId: true, state: true } } } as const

export async function findClaimById(claimId: string, db: DbClient = prisma) {
  return db.claim.findUnique({ where: { id: claimId }, include: withSource })
}

// §10 — newest first, then id: a fixed history order, never a "current" label.
export async function findClaimsForEncounter(encounterId: string, db: DbClient = prisma) {
  return db.claim.findMany({ where: { encounterId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: withSource })
}
