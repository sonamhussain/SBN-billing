import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.5 — Prisma access for remediation events. The Claim, the parent intake, its triage disposition, its investigation
// history and the actor's permissions are read through their owners (the service); here the only reads are the
// remediation rows and the identity of the actor's one membership, and the only write is the append-only event, which
// the database refuses to update, delete or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findRemediationEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionRemediationEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type RemediationEventRecord = Awaited<ReturnType<typeof findRemediationEventsOfIntake>>[number]

// The authenticated user's one membership of the organization (unique per organization and user), or null.
export async function findActorMembership(organizationId: string, userId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, organizationId: true, userId: true } })
}

export type NewRemediationEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  actionCode: string | null
  findingEventId: string | null
  rationaleCode: string | null
  proposalEventId: string | null
  decisionCode: string | null
  reviewReasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// The event is written with an explicit column list that omits recorded_at and created_at, so the database's own
// transaction time owns them (the insert guard refuses any other). The row is then read back.
export async function insertRemediationEvent(data: NewRemediationEvent, db: DbClient): Promise<RemediationEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_remediation_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "action_code", "a8_3_finding_event_id", "rationale_code", "proposal_event_id", "decision_code", "review_reason_code", "recorded_by_membership_id", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.actionCode}, ${data.findingEventId}::uuid, ${data.rationaleCode}, ${data.proposalEventId}::uuid, ${data.decisionCode}, ${data.reviewReasonCode}, ${data.recordedByMembershipId}::uuid, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionRemediationEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
