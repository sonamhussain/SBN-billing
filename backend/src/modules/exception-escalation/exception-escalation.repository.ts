import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.8 — Prisma access for escalation events. The Claim, the parent intake, its triage disposition, its investigation,
// remediation, work and resolution histories and every member's permissions are read through their owners (the
// service); here the only reads are the escalation rows and the identity of a membership (the actor's own, or a
// nominated one), and the only write is the append-only event, which the database refuses to update, delete or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findEscalationEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionEscalationEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type EscalationEventRecord = Awaited<ReturnType<typeof findEscalationEventsOfIntake>>[number]

// The authenticated user's one membership of the organization (unique per organization and user), or null.
export async function findActorMembership(organizationId: string, userId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, organizationId: true, userId: true } })
}

// A membership by id (a nominated member), or null. Another organization's membership is told apart by the caller.
export async function findMembershipById(membershipId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { id: membershipId }, select: { id: true, organizationId: true, userId: true } })
}

export type NewEscalationEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  reasonCode: string | null
  targetMemberId: string | null
  escalationEventId: string | null
  acknowledgementEventId: string | null
  followupCode: string | null
  sourceEventId: string | null
  sourceEventKind: string | null
  returnReasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// The event is written with an explicit column list that omits recorded_at and created_at, so the database's own
// transaction time owns them (the insert guard refuses any other). The row is then read back.
export async function insertEscalationEvent(data: NewEscalationEvent, db: DbClient): Promise<EscalationEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_escalation_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "reason_code", "target_member_id", "escalation_event_id", "acknowledgement_event_id", "followup_code", "source_event_id", "source_event_kind", "return_reason_code", "recorded_by_membership_id", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.reasonCode}, ${data.targetMemberId}::uuid, ${data.escalationEventId}::uuid, ${data.acknowledgementEventId}::uuid, ${data.followupCode}, ${data.sourceEventId}::uuid, ${data.sourceEventKind}, ${data.returnReasonCode}, ${data.recordedByMembershipId}::uuid, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionEscalationEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
