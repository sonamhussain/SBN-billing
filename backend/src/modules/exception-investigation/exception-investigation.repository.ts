import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.3 — Prisma access for investigation events. The Claim, the parent intake, its triage disposition and history,
// the referenced evidence and the actor's permissions are read through their owners (the service); here the only
// reads are the investigation rows and the identity of the actor's one membership, and the only write is the
// append-only event, which the database refuses to update, delete or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findInvestigationEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionInvestigationEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type InvestigationEventRecord = Awaited<ReturnType<typeof findInvestigationEventsOfIntake>>[number]

// The authenticated user's one membership of the organization (unique per organization and user), or null.
export async function findActorMembership(organizationId: string, userId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, organizationId: true, userId: true } })
}

export type NewInvestigationEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  evidenceKind: string | null
  evidenceRecordId: string | null
  evidenceContractVersion: string | null
  evidenceBasisCode: string | null
  linkedEvidenceEventId: string | null
  findingCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// The event is written with an explicit column list that omits recorded_at and created_at, so the database's own
// transaction time owns them (the insert guard refuses any other). The row is then read back.
export async function insertInvestigationEvent(data: NewInvestigationEvent, db: DbClient): Promise<InvestigationEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_investigation_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "evidence_kind", "evidence_record_id", "evidence_contract_version", "evidence_basis_code", "linked_evidence_event_id", "finding_code", "recorded_by_membership_id", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.evidenceKind}, ${data.evidenceRecordId}::uuid, ${data.evidenceContractVersion}, ${data.evidenceBasisCode}, ${data.linkedEvidenceEventId}::uuid, ${data.findingCode}, ${data.recordedByMembershipId}::uuid, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionInvestigationEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
