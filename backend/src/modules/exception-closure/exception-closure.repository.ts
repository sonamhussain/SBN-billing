import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.9 — Prisma access for closure events. The Claim, the parent intake, its triage, investigation, remediation, work,
// resolution and escalation histories, the Claim's frozen submissions and their coding status, and the actor's
// permissions are read through their owners (the service); here the only reads are the closure rows and the identity of
// the actor's one membership, and the only write is the append-only event, which the database refuses to update, delete
// or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findClosureEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionClosureEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type ClosureEventRecord = Awaited<ReturnType<typeof findClosureEventsOfIntake>>[number]

// The authenticated user's one membership of the organization (unique per organization and user), or null.
export async function findActorMembership(organizationId: string, userId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, organizationId: true, userId: true } })
}

export type NewClosureEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  resolutionDecisionEventId: string
  basisReferenceKind: string
  basisReferenceId: string
  basisOwnerContractVersion: string
  closureReasonCode: string
  recordedByMembershipId: string
  recordedByUserId: string
}

// The event is written with an explicit column list that omits recorded_at and created_at, so the database's own
// transaction time owns them (the insert guard refuses any other). The row is then read back.
export async function insertClosureEvent(data: NewClosureEvent, db: DbClient): Promise<ClosureEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_closure_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "resolution_decision_event_id", "basis_reference_kind", "basis_reference_id", "basis_owner_contract_version", "closure_reason_code", "recorded_by_membership_id", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.resolutionDecisionEventId}::uuid, ${data.basisReferenceKind}, ${data.basisReferenceId}::uuid, ${data.basisOwnerContractVersion}, ${data.closureReasonCode}, ${data.recordedByMembershipId}::uuid, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionClosureEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
