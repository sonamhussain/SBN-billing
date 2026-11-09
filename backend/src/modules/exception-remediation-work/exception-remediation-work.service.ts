import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.6 consumes, unchanged: the A6.7 Claim ownership path, the A8.1 intakes of a Claim, the A8.2 triage
// disposition, the A8.3 investigation history and the A8.5 remediation disposition and history of an intake on the
// caller's transaction, the A1 effective permissions of a member, and the database's own evaluation instant.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import type { ExceptionIntakeDto } from '../exception-intake/exception-intake.types.ts'
import { getTriageDispositionOf } from '../exception-triage/exception-triage.service.ts'
import type { TriageDispositionDto } from '../exception-triage/exception-triage.types.ts'
import { getInvestigationHistoryOf } from '../exception-investigation/exception-investigation.service.ts'
import { getRemediationDispositionOf, getRemediationHistoryOf } from '../exception-remediation/exception-remediation.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyWorkEvent, deriveWork, reconcileAttempt } from './exception-remediation-work.reducer.ts'
import { findActorMembership, findWorkEventsOfIntake, insertWorkEvent, type WorkEventRecord } from './exception-remediation-work.repository.ts'
import {
  type ApprovedPlan,
  type AttemptedWorkEvent,
  BASIS_REFERENCE_CONTRACT_VERSION,
  type BasisReferenceKind,
  INVESTIGATION_EVENT_OF_KIND,
  RECORDER_PERMISSION,
  type VerificationCode,
  type VerificationReasonCode,
  VERIFIER_PERMISSION,
  WORK_CONTRACT_VERSION,
  type WorkCode,
  type WorkDerived,
  type WorkDispositionDto,
  type WorkErrorCode,
  type WorkEventCode,
  type WorkEventDto,
  type WorkEventRequest,
  type WorkEventShape,
  type WorkHistoryDto,
  type WorkParent,
  type WorkResult,
} from './exception-remediation-work.types.ts'
import { isWorkUuid, validateWorkEvent } from './exception-remediation-work.validation.ts'

// A8.6 §7 — a work event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked the four upstream read permissions and the event's own permission (exceptionRemediationWork.record or
//    exceptionRemediationWork.verify); the body is one event and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A8.1–A8.5 convention, so an A8.2
//    reassignment, an A8.5 decision and an A8.6 write on one Claim are serialized); a busy Claim is waited for outside
//    the transaction within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the actor is judged before anything else: a reporter must be the member to whom the A8.2 disposition presently
//    ASSIGNS the exception, eligible now and holding exceptionRemediationWork.record (no Admin override); a verifier
//    must hold exceptionRemediationWork.verify now through their own membership and the exception must still be
//    ASSIGNED; the verifier's membership and user must both differ from the report's (D7: the A8.5 approver may verify);
// 5. the intake's approved plan is read through the A8.5 owner (its disposition's approvedProposalEventId, the
//    PROPOSE_ACTION it names and the APPROVE_PROPOSAL review of it in the A8.5 history), and the stored work history is
//    derived by the pure reducer against it; an inconsistent owner or work history refuses the write (never repaired);
// 6. a report's plan must be exactly that approved proposal (another intake's or a missing one is the same 404; one of
//    this intake that is not approved is 409), and its evidence is verified through the A8.3 owner: an event of
//    exactly this intake, Claim and organization (otherwise 404) whose event code is its kind's (otherwise 409); a
//    verification re-reads the A8.3 history so an unverifiable investigation fails closed;
// 7. exactly one event, numbered one more than the history, and one metadata-only audit are appended atomically; the
//    database guard re-checks time, coherence, the acting membership, the current assignment and the permission, the
//    approved plan, the work code, the evidence record and kind, the outstanding report, independence and the sequence.
// There is no idempotency key: an exact repeat is refused by the history rules, and an unknown commit outcome is never
// retried blindly: it is reconciled against the committed history and answered 409 with what that history holds.
// Nothing is executed, corrected, resolved, closed, escalated or paid, and nothing upstream changes.

class WorkRefusal extends Error {
  readonly code: WorkErrorCode
  constructor(code: WorkErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: WorkErrorCode, message: string): never {
  throw new WorkRefusal(code, message)
}

const invalid = (message: string): WorkResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const PLAN_NOT_FOUND_MESSAGE = 'remediation proposal not found for this exception'
const EVIDENCE_NOT_FOUND_MESSAGE = 'investigation record not found for this exception'
const NOT_ASSIGNEE_MESSAGE = 'only the current, eligible assignee of this exception holding the work report permission reports remediation work; nothing was recorded'
const NOT_INDEPENDENT_MESSAGE = "a work report is verified only by another member holding the verification permission now, never by its own reporter; nothing was recorded"
const NOT_ASSIGNED_MESSAGE = 'the exception is not assigned now; work is reported and verified only while the exception is assigned; nothing was recorded'
const NOT_APPROVED_MESSAGE = 'the named remediation proposal is not the approved proposal of this exception; work is reported only against an approved proposal; nothing was recorded'
const INCONSISTENT_MESSAGE = "the exception's stored remediation work history is inconsistent; nothing was derived or recorded"
const TRIAGE_UNREADABLE_MESSAGE = "the exception's triage history is inconsistent, so its assignment cannot be established; nothing was recorded"
const INVESTIGATION_UNREADABLE_MESSAGE = "the exception's investigation history is inconsistent, so the evidence cannot be verified; nothing was recorded"
const REMEDIATION_UNREADABLE_MESSAGE = "the exception's remediation history is inconsistent, so its approved proposal cannot be established; nothing was recorded"

const MAX_WORK_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence) and the one verification per report refuse a competing writer; the retry re-reads the
// history and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): WorkErrorCode | null =>
  /exception_remediation_work_assignee/.test(message)
    ? 'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE'
    : /exception_remediation_work_verifier/.test(message)
      ? 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT'
      : /exception_remediation_work_(sequence|transition|plan|code|basis)/.test(message)
        ? 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED'
        : /exception_remediation_work_(time|coherence|member)|exception_remediation_work_events is append-only/.test(message)
          ? 'EXCEPTION_REMEDIATION_WORK_CONFLICT'
          : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: WorkEventRecord): WorkEventDto {
  return {
    workEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as WorkEventCode,
    approvedProposalEventId: record.approvedProposalEventId,
    workCode: record.workCode as WorkCode | null,
    basisReferenceKind: record.basisReferenceKind as BasisReferenceKind | null,
    basisReferenceId: record.basisReferenceId,
    basisReferenceContractVersion: record.basisReferenceContractVersion,
    workReportEventId: record.workReportEventId,
    verificationCode: record.verificationCode as VerificationCode | null,
    reasonCode: record.reasonCode as VerificationReasonCode | null,
    recordedByMembershipId: record.recordedByMembershipId,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- the parent, the plan, the actor and the history ------------------------------------------------------

// The parent intake among the Claim's A8.1 intakes on tx, or null. Another Claim's or tenant's intake is not there.
async function intakeOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ExceptionIntakeDto | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  return intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId) ?? null
}

const parentOfIntake = (intake: ExceptionIntakeDto): WorkParent => ({ exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId })

type PlanRead = { plan: ApprovedPlan | null; proposalIds: string[] }

// D5 — the intake's approved A8.5 proposal through its owner on tx: the disposition's approvedProposalEventId, the
// PROPOSE_ACTION of this intake it names, and an APPROVE_PROPOSAL review of exactly that proposal in the same history.
// Not approved is a null plan; an owner history that does not agree with itself fails closed. Also every proposal id of
// the intake, so a report naming a proposal of this intake that is not approved is told apart from a foreign one.
async function planOf(claimId: string, parent: WorkParent, tx: DbClient): Promise<PlanRead | null> {
  const disposition = await getRemediationDispositionOf(claimId, parent.exceptionIntakeId, tx)
  const history = await getRemediationHistoryOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok || !history.ok) return null
  const proposals = history.value.items.filter((item) => item.eventCode === 'PROPOSE_ACTION')
  const proposalIds = proposals.map((item) => item.remediationEventId)
  const approvedId = disposition.value.approvedProposalEventId
  if (disposition.value.state !== 'APPROVED_FOR_PLANNING' || approvedId === null) return disposition.value.state === 'APPROVED_FOR_PLANNING' ? null : { plan: null, proposalIds }
  const proposal = proposals.find((item) => item.remediationEventId === approvedId)
  const approval = history.value.items.find((item) => item.eventCode === 'REVIEW_ACTION' && item.proposalEventId === approvedId && item.decisionCode === 'APPROVE_PROPOSAL')
  if (!proposal || !approval || proposal.actionCode === null) return null
  const coherent = [proposal, approval].every((item) => item.exceptionIntakeId === parent.exceptionIntakeId && item.organizationId === parent.organizationId && item.claimId === parent.claimId)
  return coherent ? { plan: { approvedProposalEventId: approvedId, actionCode: proposal.actionCode }, proposalIds } : null
}

async function historyOf(parent: WorkParent, plan: ApprovedPlan | null, tx: DbClient): Promise<{ records: WorkEventRecord[]; derived: WorkDerived } | null> {
  const records = await findWorkEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveWork(parent, plan, records)
  return derived.ok ? { records, derived: derived.value } : null
}

async function dispositionOf(claimId: string, parent: WorkParent, tx: DbClient): Promise<TriageDispositionDto> {
  const disposition = await getTriageDispositionOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok) return disposition.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_REMEDIATION_WORK_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
  return disposition.value
}

// The acting user's own membership of the organization, if its effective roles grant `permission` now; otherwise null.
async function membershipHolding(parent: WorkParent, actorUserId: string, permission: string, tx: DbClient): Promise<string | null> {
  const membership = await findActorMembership(parent.organizationId, actorUserId, tx)
  if (!membership) return null
  const access = await getEffectivePermissions(actorUserId, parent.organizationId)
  return access && access.membershipId === membership.id && access.permissions.includes(permission) ? membership.id : null
}

// D6 — a reporter is the member to whom the A8.2 disposition presently assigns the exception, eligible now under the
// A8.2 policy, holding exceptionRemediationWork.record now. Otherwise null.
async function actingReporter(claimId: string, parent: WorkParent, actorUserId: string, tx: DbClient): Promise<string | null> {
  const disposition = await dispositionOf(claimId, parent, tx)
  const membershipId = await membershipHolding(parent, actorUserId, RECORDER_PERMISSION, tx)
  if (!membershipId) return null
  const { dispositionCode, assignedMemberId, assigneeCurrentlyEligible } = disposition
  return dispositionCode === 'ASSIGNED' && assignedMemberId === membershipId && assigneeCurrentlyEligible === true ? membershipId : null
}

// D7 — a verifier holds exceptionRemediationWork.verify now through their own membership, and the exception is still
// ASSIGNED. Independence from the reporter is judged against the history, below.
async function actingVerifier(claimId: string, parent: WorkParent, actorUserId: string, tx: DbClient): Promise<string> {
  const disposition = await dispositionOf(claimId, parent, tx)
  const membershipId = await membershipHolding(parent, actorUserId, VERIFIER_PERMISSION, tx)
  if (!membershipId) return refuse('EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT', NOT_INDEPENDENT_MESSAGE)
  if (disposition.dispositionCode !== 'ASSIGNED') return refuse('EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED', NOT_ASSIGNED_MESSAGE)
  return membershipId
}

// The A8.3 history of this intake, read through its owner on tx. An inconsistent investigation fails closed.
async function investigationOf(claimId: string, parent: WorkParent, tx: DbClient) {
  const history = await getInvestigationHistoryOf(claimId, parent.exceptionIntakeId, tx)
  if (!history.ok) return history.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_REMEDIATION_WORK_CONFLICT', INVESTIGATION_UNREADABLE_MESSAGE)
  return history.value
}

// D3/D4 — the evidence a report cites: an A8.3 event of exactly this intake, organization and Claim (otherwise the same
// 404 as a missing one) whose event code is its kind's (otherwise 409).
async function verifiedEvidence(claimId: string, parent: WorkParent, kind: BasisReferenceKind, recordId: string, tx: DbClient): Promise<void> {
  const investigation = await investigationOf(claimId, parent, tx)
  const event = investigation.items.find((item) => item.investigationEventId === recordId)
  if (!event || event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId) refuse('NOT_FOUND', EVIDENCE_NOT_FOUND_MESSAGE)
  if (event.eventCode !== INVESTIGATION_EVENT_OF_KIND[kind]) refuse('EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED', `the named investigation event is not of the kind ${kind}; nothing was recorded`)
}

// ---- record (§7, POST remediation-work-events) -----------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function recordOnTransaction(claimId: string, exceptionIntakeId: string, request: WorkEventRequest, actorUserId: string, tx: DbClient, attempted?: { event: AttemptedWorkEvent | null }): Promise<WorkEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionRemediationWork.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const intake = await intakeOf(claimId, exceptionIntakeId, tx)
  if (!intake) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = parentOfIntake(intake)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_REMEDIATION_WORK_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the actor, before anything else is judged.
  const membershipId =
    request.eventCode === 'RECORD_WORK_REPORT'
      ? ((await actingReporter(claimId, parent, actorUserId, tx)) ?? refuse('EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE', NOT_ASSIGNEE_MESSAGE))
      : await actingVerifier(claimId, parent, actorUserId, tx)

  // 5 — the approved plan through its A8.5 owner, then the stored work history against it.
  const planRead = (await planOf(claimId, parent, tx)) ?? refuse('EXCEPTION_REMEDIATION_WORK_CONFLICT', REMEDIATION_UNREADABLE_MESSAGE)
  const history = await historyOf(parent, planRead.plan, tx)
  if (!history) return refuse('EXCEPTION_REMEDIATION_WORK_CONFLICT', INCONSISTENT_MESSAGE)

  // 6 — the plan and the evidence through their owners, independence from the reporter, then the next step.
  let shape: WorkEventShape
  if (request.eventCode === 'RECORD_WORK_REPORT') {
    if (planRead.plan?.approvedProposalEventId !== request.approvedProposalEventId)
      return planRead.proposalIds.includes(request.approvedProposalEventId) ? refuse('EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED', NOT_APPROVED_MESSAGE) : refuse('NOT_FOUND', PLAN_NOT_FOUND_MESSAGE)
    await verifiedEvidence(claimId, parent, request.basisReferenceKind, request.basisReferenceId, tx)
    shape = {
      eventCode: request.eventCode,
      approvedProposalEventId: request.approvedProposalEventId,
      workCode: request.workCode,
      basisReferenceKind: request.basisReferenceKind,
      basisReferenceId: request.basisReferenceId,
      basisReferenceContractVersion: BASIS_REFERENCE_CONTRACT_VERSION,
      workReportEventId: null,
      verificationCode: null,
      reasonCode: null,
      recordedByMembershipId: membershipId,
      recordedByUserId: actorUserId,
    }
  } else {
    await investigationOf(claimId, parent, tx)
    const report = history.derived.report
    if (history.derived.state === 'AWAITING_VERIFICATION' && report && (report.reportedByMembershipId === membershipId || report.reportedByUserId === actorUserId))
      refuse('EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT', NOT_INDEPENDENT_MESSAGE)
    if (!planRead.plan) return refuse('EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED', 'no work report of this exception awaits verification; nothing was recorded')
    shape = {
      eventCode: request.eventCode,
      approvedProposalEventId: planRead.plan.approvedProposalEventId,
      workCode: null,
      basisReferenceKind: null,
      basisReferenceId: null,
      basisReferenceContractVersion: null,
      workReportEventId: request.workReportEventId,
      verificationCode: request.verificationCode,
      reasonCode: request.reasonCode,
      recordedByMembershipId: membershipId,
      recordedByUserId: actorUserId,
    }
  }
  const next = applyWorkEvent(history.derived, planRead.plan, shape)
  if (!next.ok) return refuse('EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED', `${next.detail}; nothing was recorded`)

  // 7 — one event and one business audit, atomically.
  const sequence = next.derived.lastSequence
  if (attempted) attempted.event = { ...shape, sequence }
  const event = await insertWorkEvent({ ...parent, ...shape, approvedProposalEventId: shape.approvedProposalEventId as string, contractVersion: WORK_CONTRACT_VERSION, sequence }, tx)
  await concurrencyProbe('exceptionRemediationWork.inserted')
  // Metadata only: ids, contract, sequence, the controlled codes, the plan, evidence and report pointers, the acting
  // membership and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_remediation_work.recorded',
      entityType: 'EXCEPTION_REMEDIATION_WORK_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        workEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        approvedProposalEventId: event.approvedProposalEventId,
        workCode: event.workCode,
        basisReferenceKind: event.basisReferenceKind,
        basisReferenceId: event.basisReferenceId,
        basisReferenceContractVersion: event.basisReferenceContractVersion,
        workReportEventId: event.workReportEventId,
        verificationCode: event.verificationCode,
        reasonCode: event.reasonCode,
        recordedByMembershipId: event.recordedByMembershipId,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionRemediationWork.audited')
  return toEventDto(event)
}

// An unknown outcome is reconciled against the exact committed history on a fresh read: the event at the attempted
// sequence either is exactly this request (membership, actor and every controlled field), is another event, or does
// not exist. Nothing is retried and success is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedWorkEvent | null): Promise<WorkResult<never>> {
  const conflict = (message: string): WorkResult<never> => ({ ok: false, code: 'EXCEPTION_REMEDIATION_WORK_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findWorkEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's remediation work history before requesting again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this event at sequence ${attempted.sequence} (work event ${reconciled.workEventId}); it was not requested again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this request was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): WorkResult<WorkEventRequest> => {
  if (!isWorkUuid(claimId)) return invalid('invalid claim id')
  if (!isWorkUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateWorkEvent(body)
  return event.ok ? { ok: true, value: event.value } : { ok: false, code: event.code, message: event.message }
}

export async function recordWorkEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<WorkResult<WorkEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedWorkEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof WorkRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_REMEDIATION_WORK_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_WORK_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_REMEDIATION_WORK_CONFLICT', message: 'concurrent remediation work requests for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the remediation work event; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The event on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordWorkEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<WorkResult<WorkEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof WorkRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§7) --------------------------------------------------------------------------------------

async function readParentAndHistory(
  claimId: string,
  exceptionIntakeId: string,
  tx: DbClient,
): Promise<WorkResult<{ parent: WorkParent; plan: ApprovedPlan | null; records: WorkEventRecord[]; derived: WorkDerived }>> {
  if (!isWorkUuid(claimId)) return invalid('invalid claim id')
  if (!isWorkUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const intake = await intakeOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!intake) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = parentOfIntake(intake)
  const planRead = parent.organizationId === claim.organizationId ? await planOf(claimId.toLowerCase(), parent, tx) : null
  const history = planRead ? await historyOf(parent, planRead.plan, tx) : null
  if (!planRead || !history) return { ok: false, code: 'EXCEPTION_REMEDIATION_WORK_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, plan: planRead.plan, ...history } }
}

// One intake's history on the CALLER's transaction — what later owners consult. Nothing is written.
export async function getWorkHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<WorkResult<WorkHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return { ok: true, value: { contractVersion: WORK_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() } }
}

// One intake's derived work disposition on the CALLER's transaction — the reader a future owner consults. It opens no
// transaction of its own and writes nothing. The A8.1–A8.5 records stay their own sources of truth and are not copied.
// A historical verification is never recomputed from present permissions or present source status.
export async function getWorkDispositionOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<WorkResult<WorkDispositionDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { derived, records, parent, plan } = read.value
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: WORK_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      state: derived.state,
      approvedProposalEventId: plan?.approvedProposalEventId ?? null,
      report: derived.report,
      verification: derived.verification,
      eventCount: records.length,
      lastSequence: records.length > 0 ? derived.lastSequence : null,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getWorkHistory(claimId: string, exceptionIntakeId: string): Promise<WorkResult<WorkHistoryDto>> {
  if (!isWorkUuid(claimId) || !isWorkUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getWorkHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getWorkDisposition(claimId: string, exceptionIntakeId: string): Promise<WorkResult<WorkDispositionDto>> {
  if (!isWorkUuid(claimId) || !isWorkUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getWorkDispositionOf(claimId, exceptionIntakeId, tx))
}
