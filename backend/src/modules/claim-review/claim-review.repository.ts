import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.5 — Prisma access for human review decisions. The Claim, its creator and the A6.4 assessment are READ
// from their owners; the only write is the append-only decision, which the database refuses to update or
// delete.

// The Claim's creator and owning organization — nothing else of the Claim is needed here.
export async function findClaimForReview(claimId: string, db: DbClient) {
  const row = await db.claim.findUnique({ where: { id: claimId }, select: { id: true, createdByUserId: true, encounter: { select: { patient: { select: { organizationId: true } } } } } })
  return row ? { id: row.id, createdByUserId: row.createdByUserId, organizationId: row.encounter.patient.organizationId } : null
}

// The stored A6.4 assessment exactly as recorded: its Claim, the pricing run it judged, its outcome,
// fingerprint and creator.
export async function findAssessmentForReview(id: string, db: DbClient) {
  return db.claimDraftAssessment.findUnique({ where: { id }, select: { id: true, claimId: true, pricingRunId: true, outcome: true, assemblyFingerprint: true, createdByUserId: true } })
}

// The Claim's latest decision by its Claim-local sequence — never by time or identifier.
export async function findLatestDecision(claimId: string, db: DbClient) {
  return db.claimReviewDecision.findFirst({
    where: { claimId },
    orderBy: { sequence: 'desc' },
    select: { id: true, decisionCode: true, draftAssessmentId: true, approvalFingerprint: true, sequence: true },
  })
}

export type NewDecision = {
  claimId: string
  draftAssessmentId: string
  reviewerUserId: string
  decisionCode: string
  sequence: number
  approvalFingerprint: string | null
  reasonCode: string | null
  referencedApprovalId: string | null
  reviewContractVersion: string
}

// The decision row is written with an explicit column list that omits reviewed_at and created_at, so both
// take the database's own transaction time (the client never supplies an instant; the insert guard refuses
// one). The row is then read back through Prisma.
export async function createDecisionRecord(data: NewDecision, db: DbClient) {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "claim_review_events" ("id", "claim_id", "draft_assessment_id", "reviewer_user_id", "decision_code", "sequence", "approval_fingerprint", "reason_code", "referenced_approval_id", "review_contract_version")
    VALUES (gen_random_uuid(), ${data.claimId}::uuid, ${data.draftAssessmentId}::uuid, ${data.reviewerUserId}::uuid, ${data.decisionCode}, ${data.sequence}::int, ${data.approvalFingerprint}, ${data.reasonCode}, ${data.referencedApprovalId}::uuid, ${data.reviewContractVersion})
    RETURNING "id"::text AS "id"`)
  return db.claimReviewDecision.findUniqueOrThrow({ where: { id: inserted.id } })
}

export async function findDecisionById(id: string, db: DbClient = prisma) {
  return db.claimReviewDecision.findUnique({ where: { id } })
}

// The Claim's history in ascending sequence: the order the decisions were made, never a recency guess.
export async function findDecisionsOfClaim(claimId: string, db: DbClient = prisma) {
  return db.claimReviewDecision.findMany({ where: { claimId }, orderBy: { sequence: 'asc' } })
}

// The owning organization of a decision, through its Claim.
export async function findDecisionOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimReviewDecision.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}
