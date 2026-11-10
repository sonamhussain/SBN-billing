import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A8.6 — Prisma access for remediation work events. The Claim, the parent intake, its triage disposition, its
// investigation and remediation histories and the actor's permissions are read through their owners (the service);
// here the only reads are the work rows and the identity of the actor's one membership, and the only write is the
// append-only event, which the database refuses to update, delete or truncate.

// One intake's events in their server-owned sequence (the stored contract), never by time or identifier.
export async function findWorkEventsOfIntake(exceptionIntakeId: string, db: DbClient) {
  return db.exceptionRemediationWorkEvent.findMany({ where: { exceptionIntakeId }, orderBy: { sequence: 'asc' } })
}

export type WorkEventRecord = Awaited<ReturnType<typeof findWorkEventsOfIntake>>[number]

// The authenticated user's one membership of the organization (unique per organization and user), or null.
export async function findActorMembership(organizationId: string, userId: string, db: DbClient) {
  return db.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { id: true, organizationId: true, userId: true } })
}

export type NewWorkEvent = {
  exceptionIntakeId: string
  organizationId: string
  claimId: string
  contractVersion: string
  sequence: number
  eventCode: string
  approvedProposalEventId: string
  workCode: string | null
  basisReferenceKind: string | null
  basisReferenceId: string | null
  basisReferenceContractVersion: string | null
  workReportEventId: string | null
  verificationCode: string | null
  reasonCode: string | null
  recordedByMembershipId: string
  recordedByUserId: string
}

// The event is written with an explicit column list that omits recorded_at and created_at, so the database's own
// transaction time owns them (the insert guard refuses any other). The row is then read back.
export async function insertWorkEvent(data: NewWorkEvent, db: DbClient): Promise<WorkEventRecord> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "exception_remediation_work_events" ("id", "exception_intake_id", "organization_id", "claim_id", "contract_version", "sequence", "event_code", "approved_proposal_event_id", "work_code", "basis_reference_kind", "basis_reference_id", "basis_reference_contract_version", "work_report_event_id", "verification_code", "reason_code", "recorded_by_membership_id", "recorded_by_user_id")
    VALUES (gen_random_uuid(), ${data.exceptionIntakeId}::uuid, ${data.organizationId}::uuid, ${data.claimId}::uuid, ${data.contractVersion}, ${data.sequence}, ${data.eventCode}, ${data.approvedProposalEventId}::uuid, ${data.workCode}, ${data.basisReferenceKind}, ${data.basisReferenceId}::uuid, ${data.basisReferenceContractVersion}, ${data.workReportEventId}::uuid, ${data.verificationCode}, ${data.reasonCode}, ${data.recordedByMembershipId}::uuid, ${data.recordedByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return db.exceptionRemediationWorkEvent.findUniqueOrThrow({ where: { id: inserted.id } })
}
