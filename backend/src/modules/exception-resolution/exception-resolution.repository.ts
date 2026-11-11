import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.7 — Prisma access for resolution events. The Claim, the parent intake, its triage disposition, its investigation,
// remediation and remediation work histories and the actor's permissions are read through their owners (the service);
// here the only reads are the resolution rows and the identity of the actor's one membership, and the only write is the
// append-only event, which the database refuses to update, delete or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findResolutionEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionResolutionEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type ResolutionEventRecord = Awaited<ReturnType<typeof findResolutionEventsOfIntake>>[number]

// The authenticated user's one membership of the organization (unique per organization and user), or null.
export async function findActorMembership(organizationId: string, userId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, organizationId: true, userId: true } })
}

export type NewResolutionEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  verificationEventId: string | null
  requestEventId: string | null
  reasonCode: string | null
  decisionCode: string | null
  returnReasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// The event is written with an explicit column list that omits recorded_at and created_at, so the database's own
// transaction time owns them (the insert guard refuses any other). The row is then read back.
export async function insertResolutionEvent(data: NewResolutionEvent, db: DbClient): Promise<ResolutionEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_resolution_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "verification_event_id", "request_event_id", "reason_code", "decision_code", "return_reason_code", "recorded_by_membership_id", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.verificationEventId}::uuid, ${data.requestEventId}::uuid, ${data.reasonCode}, ${data.decisionCode}, ${data.returnReasonCode}, ${data.recordedByMembershipId}::uuid, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionResolutionEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
