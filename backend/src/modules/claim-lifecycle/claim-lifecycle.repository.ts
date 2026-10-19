import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A6.8 — Prisma access for internal lifecycle events. The frozen submission is READ from its A6.7 owner
// (identity, Claim and organization only — never its bytes or manifest); the only write is the append-only
// event, which the database refuses to update or delete.

// The frozen submission's Claim and owning organization. Nothing else of the freeze is needed here.
export async function findSubmissionForLifecycle(submissionId: string, db: DbClient) {
  const row = await db.claimFreeze.findUnique({
    where: { id: submissionId },
    select: { id: true, claimId: true, claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
  return row ? { id: row.id, claimId: row.claimId, organizationId: row.claim.encounter.patient.organizationId } : null
}

// The submission's events in ascending submission-local sequence — never by time or identifier.
export async function findLifecycleEvents(submissionId: string, db: DbClient) {
  return db.claimFreezeLifecycleEvent.findMany({ where: { claimFreezeId: submissionId }, orderBy: { sequence: 'asc' } })
}

export type LifecycleEventRecord = Awaited<ReturnType<typeof findLifecycleEvents>>[number]

export type NewLifecycleEvent = {
  submissionId: string
  sequence: number
  eventCode: string
  reasonCode: string | null
  actorUserId: string
  lifecycleContractVersion: string
}

// The event is written with an explicit column list that omits occurred_at and created_at, so both take the
// database's own transaction time (the client never supplies an instant; the insert guard refuses one). The
// row is then read back through Prisma.
export async function insertLifecycleEvent(data: NewLifecycleEvent, db: DbClient): Promise<LifecycleEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "claim_freeze_lifecycle_events" ("id", "claim_submission_id", "sequence", "event_code", "reason_code", "actor_user_id", "lifecycle_contract_version")
    VALUES (gen_random_uuid(), ${data.submissionId}::uuid, ${data.sequence}::int, ${data.eventCode}, ${data.reasonCode}, ${data.actorUserId}::uuid, ${data.lifecycleContractVersion})
    RETURNING "id"::text AS "id"`)
  return db.claimFreezeLifecycleEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}

// The database's own transaction time (the evaluation instant of a derived disposition).
export async function transactionTime(db: DbClient): Promise<Date> {
  return (await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now
}
