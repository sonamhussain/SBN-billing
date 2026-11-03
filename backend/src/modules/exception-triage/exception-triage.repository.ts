import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.2 — Prisma access for triage events. The Claim, the parent intake and the assignee's permissions are read
// through their owners (the service); here the only reads are the triage rows and the identity of one membership,
// and the only write is the append-only event, which the database refuses to update, delete or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findTriageEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionTriageEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type TriageEventRecord = Awaited<ReturnType<typeof findTriageEventsOfIntake>>[number]

// The organization and user of one membership, for the eligibility check; nothing else of the member is read.
export async function findMembershipForAssignment(membershipId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { id: membershipId }, select: { id: true, organizationId: true, userId: true } })
}

export type NewTriageEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  categoryCode: string | null
  priorityCode: string | null
  assignedMemberId: string | null
  reasonCode: string | null
  recordedByUserId: string
}

// The event is written with an explicit column list that omits id, recorded_at and created_at, so the server and the
// database's own transaction time own them (the insert guard refuses any other). The row is then read back.
export async function insertTriageEvent(data: NewTriageEvent, db: DbClient): Promise<TriageEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_triage_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "category_code", "priority_code", "assigned_member_id", "reason_code", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.categoryCode}, ${data.priorityCode}, ${data.assignedMemberId}::uuid, ${data.reasonCode}, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionTriageEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
