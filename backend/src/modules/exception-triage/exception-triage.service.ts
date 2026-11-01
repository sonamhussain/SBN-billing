import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.2 consumes, unchanged: the A6.7 Claim ownership path, the A8.1 intakes of a Claim on the caller's
// transaction, the A1 effective permissions of a member, and the database's own evaluation instant.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyTriageEvent, deriveTriageDisposition, reconcileAttempt } from './exception-triage.reducer.ts'
import { findMembershipForAssignment, findTriageEventsOfIntake, insertTriageEvent, type TriageEventRecord } from './exception-triage.repository.ts'
import {
  ASSIGNEE_PERMISSION,
  type AttemptedTriageEvent,
  TRIAGE_CONTRACT_VERSION,
  type DispositionState,
  type ReturnReasonCode,
  type TriageCategoryCode,
  type TriageDispositionDto,
  type TriageErrorCode,
  type TriageEventCode,
  type TriageEventDto,
  type TriageEventRequest,
  type TriageEventShape,
  type TriageHistoryDto,
  type TriageParent,
  type TriagePriorityCode,
  type TriageResult,
} from './exception-triage.types.ts'
import { isTriageUuid, validateTriageEvent } from './exception-triage.validation.ts'

// A8.2 §5/§6 — a triage event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked exceptionIntake.read and exceptionTriage.record; the body is one event and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted convention); a busy Claim is waited for
//    outside the transaction within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the intake's stored history is derived by the pure reducer; an inconsistent history refuses the write (never
//    repaired), and the requested event must be a legal transition from it (otherwise 409, nothing written);
// 5. an assignee must be a membership of the same organization whose roles grant exceptionTriage.record now; a
//    missing, foreign and ineligible member are answered identically (409);
// 6. exactly one event, numbered one more than the history, and one metadata-only audit are appended atomically; the
//    database guard re-checks time, coherence, membership, sequence, transition and eligibility.
// There is no idempotency key: an exact repeat is refused by the transition rules, and an unknown commit outcome is
// never retried blindly: it is reconciled against the committed history and answered 409 with what that history holds. Nothing is investigated, resolved, closed, escalated, paid or changed in the intake.

class TriageRefusal extends Error {
  readonly code: TriageErrorCode
  constructor(code: TriageErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: TriageErrorCode, message: string): never {
  throw new TriageRefusal(code, message)
}

const invalid = (message: string): TriageResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const NOT_ELIGIBLE_MESSAGE = 'the member is not eligible to own this exception; nothing was recorded'
const INCONSISTENT_MESSAGE = "the exception's stored triage history is inconsistent; nothing was derived or recorded"

const MAX_TRIAGE_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence) refuses a competing writer; the retry re-reads the history and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): TriageErrorCode | null =>
  /exception_triage_assignee/.test(message)
    ? 'EXCEPTION_TRIAGE_ASSIGNEE_NOT_ELIGIBLE'
    : /exception_triage_(transition|sequence)/.test(message)
      ? 'EXCEPTION_TRIAGE_TRANSITION_REFUSED'
      : /exception_triage_(time|coherence|member)|exception_triage_events is append-only/.test(message)
        ? 'EXCEPTION_TRIAGE_CONFLICT'
        : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: TriageEventRecord): TriageEventDto {
  return {
    triageEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as TriageEventCode,
    categoryCode: record.categoryCode as TriageCategoryCode | null,
    priorityCode: record.priorityCode as TriagePriorityCode | null,
    assignedMemberId: record.assignedMemberId,
    reasonCode: record.reasonCode as ReturnReasonCode | null,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

const shapeOf = (request: TriageEventRequest): TriageEventShape => ({
  eventCode: request.eventCode,
  categoryCode: request.eventCode === 'TRIAGE_CLASSIFY' ? request.categoryCode : null,
  priorityCode: request.eventCode === 'TRIAGE_CLASSIFY' ? request.priorityCode : null,
  assignedMemberId: request.eventCode === 'ASSIGN_OWNER' || request.eventCode === 'REASSIGN_OWNER' ? request.assignedMemberId : null,
  reasonCode: request.eventCode === 'RETURN_TO_TRIAGE' ? request.reasonCode : null,
})

// ---- the parent and its history --------------------------------------------------------------------------

// The parent intake among the Claim's A8.1 intakes on tx, or null. Another Claim's or tenant's intake is not there.
async function parentOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<TriageParent | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  const intake = intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId)
  return intake ? { exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId } : null
}

async function historyOf(parent: TriageParent, tx: DbClient): Promise<{ records: TriageEventRecord[]; state: DispositionState } | null> {
  const records = await findTriageEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveTriageDisposition(parent, records)
  return derived.ok ? { records, state: derived.value } : null
}

// A membership of exactly this organization whose roles grant exceptionTriage.record now (A1's own permission view).
async function assigneeEligible(membershipId: string, organizationId: string, tx: DbClient): Promise<boolean> {
  const membership = await findMembershipForAssignment(membershipId, tx)
  if (!membership || membership.organizationId !== organizationId) return false
  const access = await getEffectivePermissions(membership.userId, organizationId)
  return !!access && access.membershipId === membership.id && access.permissions.includes(ASSIGNEE_PERMISSION)
}

// ---- record (§5, POST triage-events) ------------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function recordOnTransaction(claimId: string, exceptionIntakeId: string, request: TriageEventRequest, actorUserId: string, tx: DbClient, attempted?: { event: AttemptedTriageEvent | null }): Promise<TriageEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionTriage.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = await parentOf(claimId, exceptionIntakeId, tx)
  if (!parent) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_TRIAGE_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the stored history, then the transition.
  const history = await historyOf(parent, tx)
  if (!history) return refuse('EXCEPTION_TRIAGE_CONFLICT', INCONSISTENT_MESSAGE)
  const shape = shapeOf(request)
  const next = applyTriageEvent(history.state, shape)
  if (!next.ok) return refuse('EXCEPTION_TRIAGE_TRANSITION_REFUSED', `${next.detail}; nothing was recorded`)

  // 5 — an assignee's eligibility at this moment.
  if (shape.assignedMemberId !== null && !(await assigneeEligible(shape.assignedMemberId, parent.organizationId, tx))) return refuse('EXCEPTION_TRIAGE_ASSIGNEE_NOT_ELIGIBLE', NOT_ELIGIBLE_MESSAGE)

  // 6 — one event and one business audit, atomically.
  if (attempted) attempted.event = { ...shape, sequence: next.state.lastSequence, recordedByUserId: actorUserId }
  const event = await insertTriageEvent({ ...parent, ...shape, contractVersion: TRIAGE_CONTRACT_VERSION, sequence: next.state.lastSequence, recordedByUserId: actorUserId }, tx)
  await concurrencyProbe('exceptionTriage.inserted')
  // §6 — metadata only: ids, contract, sequence, the controlled codes, the assigned membership and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_triage.recorded',
      entityType: 'EXCEPTION_TRIAGE_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        triageEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        categoryCode: event.categoryCode,
        priorityCode: event.priorityCode,
        assignedMemberId: event.assignedMemberId,
        reasonCode: event.reasonCode,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionTriage.audited')
  return toEventDto(event)
}

// D12 — an unknown outcome is reconciled against the exact committed history on a fresh read: the event at the
// attempted sequence either is exactly this request (actor and every controlled field), is another event, or does
// not exist. Nothing is retried and success is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedTriageEvent | null): Promise<TriageResult<never>> {
  const conflict = (message: string): TriageResult<never> => ({ ok: false, code: 'EXCEPTION_TRIAGE_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findTriageEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's triage history before requesting again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this event at sequence ${attempted.sequence} (triage event ${reconciled.triageEventId}); it was not requested again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this request was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): TriageResult<TriageEventRequest> => {
  if (!isTriageUuid(claimId)) return invalid('invalid claim id')
  if (!isTriageUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateTriageEvent(body)
  return event.ok ? { ok: true, value: event.value } : invalid(event.message)
}

export async function recordTriageEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<TriageResult<TriageEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedTriageEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof TriageRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_TRIAGE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_TRIAGE_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_TRIAGE_CONFLICT', message: 'concurrent triage requests for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the triage event; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The event on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordTriageEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<TriageResult<TriageEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof TriageRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§5) --------------------------------------------------------------------------------------

async function readParentAndHistory(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<TriageResult<{ parent: TriageParent; records: TriageEventRecord[]; state: DispositionState }>> {
  if (!isTriageUuid(claimId)) return invalid('invalid claim id')
  if (!isTriageUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = await parentOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!parent) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const history = parent.organizationId === claim.organizationId ? await historyOf(parent, tx) : null
  if (!history) return { ok: false, code: 'EXCEPTION_TRIAGE_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, ...history } }
}

// One intake's history on the CALLER's transaction — what later A8 owners consult. Nothing is written.
export async function getTriageHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<TriageResult<TriageHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return { ok: true, value: { contractVersion: TRIAGE_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() } }
}

// One intake's derived disposition on the CALLER's transaction. Nothing is written.
export async function getTriageDispositionOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<TriageResult<TriageDispositionDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { state, records, parent } = read.value
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: TRIAGE_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      dispositionCode: state.dispositionCode,
      categoryCode: state.categoryCode,
      priorityCode: state.priorityCode,
      assignedMemberId: state.assignedMemberId,
      assigneeCurrentlyEligible: state.assignedMemberId === null ? null : await assigneeEligible(state.assignedMemberId, parent.organizationId, tx),
      eventCount: records.length,
      lastSequence: records.length > 0 ? state.lastSequence : null,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getTriageHistory(claimId: string, exceptionIntakeId: string): Promise<TriageResult<TriageHistoryDto>> {
  if (!isTriageUuid(claimId) || !isTriageUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getTriageHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getTriageDisposition(claimId: string, exceptionIntakeId: string): Promise<TriageResult<TriageDispositionDto>> {
  if (!isTriageUuid(claimId) || !isTriageUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getTriageDispositionOf(claimId, exceptionIntakeId, tx))
}
