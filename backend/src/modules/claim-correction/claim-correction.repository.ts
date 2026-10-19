import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.9 — Prisma access for correction links. The Claim and both freezes are READ from their owners (identity,
// Claim, draft assessment and the database-authored freeze instant only — never bytes or manifests); the only
// write is the append-only link, which the database refuses to update or delete.

// The Claim's owning organization — nothing else of the Claim is needed here.
export async function findClaimForCorrection(claimId: string, db: DbClient) {
  const row = await db.claim.findUnique({ where: { id: claimId }, select: { id: true, encounter: { select: { patient: { select: { organizationId: true } } } } } })
  return row ? { id: row.id, organizationId: row.encounter.patient.organizationId } : null
}

// The chronology facts of one freeze. The instant is read at the database's own microsecond precision (as
// epoch microseconds), never rounded through a JavaScript Date.
export async function findFreezeFacts(submissionId: string, db: DbClient) {
  const rows = await db.$queryRaw<{ id: string; claim_id: string; draft_assessment_id: string; frozen_us: bigint }[]>`
    SELECT "id"::text AS "id", "claim_id"::text AS "claim_id", "draft_assessment_id"::text AS "draft_assessment_id",
           (extract(epoch FROM "frozen_at") * 1000000)::bigint AS "frozen_us"
    FROM "claim_freezes" WHERE "id" = ${submissionId}::uuid`
  const row = rows[0]
  return row ? { id: row.id, claimId: row.claim_id, draftAssessmentId: row.draft_assessment_id, frozenAtMicros: Number(row.frozen_us) } : null
}

// Every link of a Claim. Their order is derived by the pure chain logic, never by time or identifier.
export async function findLinksOfClaim(claimId: string, db: DbClient) {
  return db.claimCorrectionLink.findMany({ where: { claimId } })
}

export type CorrectionLinkRecord = Awaited<ReturnType<typeof findLinksOfClaim>>[number]

export async function findLinkById(id: string, db: DbClient = prisma) {
  return db.claimCorrectionLink.findUnique({ where: { id } })
}

// The link that already starts at a prior, or already ends at a correction (each is unique).
export async function findLinkByPrior(priorSubmissionId: string, db: DbClient) {
  return db.claimCorrectionLink.findUnique({ where: { priorSubmissionId } })
}

export async function findLinkByCorrected(correctedSubmissionId: string, db: DbClient) {
  return db.claimCorrectionLink.findUnique({ where: { correctedSubmissionId } })
}

export type NewCorrectionLink = {
  claimId: string
  priorSubmissionId: string
  correctedSubmissionId: string
  reasonCode: string
  recordedByUserId: string
  contractVersion: string
}

// The link is written with an explicit column list that omits recorded_at and created_at, so both take the
// database's own transaction time (the client never supplies an instant; the insert guard refuses one). The
// row is then read back through Prisma.
export async function insertCorrectionLink(data: NewCorrectionLink, db: DbClient): Promise<CorrectionLinkRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "claim_correction_links" ("id", "claim_id", "prior_submission_id", "corrected_submission_id", "reason_code", "recorded_by_user_id", "contract_version")
    VALUES (gen_random_uuid(), ${data.claimId}::uuid, ${data.priorSubmissionId}::uuid, ${data.correctedSubmissionId}::uuid, ${data.reasonCode}, ${data.recordedByUserId}::uuid, ${data.contractVersion})
    RETURNING "id"::text AS "id"`)
  return db.claimCorrectionLink.findUniqueOrThrow({ where: { id: inserted.id } })
}

// The owning organization of a link, through its Claim.
export async function findLinkOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimCorrectionLink.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}
