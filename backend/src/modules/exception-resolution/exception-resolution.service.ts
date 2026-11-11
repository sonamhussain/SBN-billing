import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.7 consumes, unchanged: the A6.7 Claim ownership path, the A8.1 intakes of a Claim, the A8.2 triage
// disposition, the A8.3 investigation history, the A8.5 remediation disposition and the A8.6 work disposition and
// history of an intake on the caller's transaction, the A1 effective permissions of a member, and the database's own
// evaluation instant.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import type { ExceptionIntakeDto } from '../exception-intake/exception-intake.types.ts'
import { getTriageDispositionOf } from '../exception-triage/exception-triage.service.ts'
import type { TriageDispositionDto } from '../exception-triage/exception-triage.types.ts'
import { getInvestigationHistoryOf } from '../exception-investigation/exception-investigation.service.ts'
import { getRemediationDispositionOf } from '../exception-remediation/exception-remediation.service.ts'
import { getWorkDispositionOf, getWorkHistoryOf } from '../exception-remediation-work/exception-remediation-work.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyResolutionEvent, deriveResolution, reconcileAttempt, verifiedBasisOf } from './exception-resolution.reducer.ts'
import { findActorMembership, findResolutionEventsOfIntake, insertResolutionEvent, type ResolutionEventRecord } from './exception-resolution.repository.ts'
import {
  type AttemptedResolutionEvent,
  type DecisionCode,
  DECIDER_PERMISSION,
  type RequestReasonCode,
  REQUESTER_PERMISSION,
  RESOLUTION_CONTRACT_VERSION,
  type ResolutionDerived,
  type ResolutionDispositionDto,
  type ResolutionErrorCode,
  type ResolutionEventCode,
  type ResolutionEventDto,
  type ResolutionEventRequest,
  type ResolutionEventShape,
  type ResolutionHistoryDto,
  type ResolutionParent,
  type ResolutionRefusal,
  type ResolutionResult,
  type ReturnReasonCode,
  type VerifiedBasis,
} from './exception-resolution.types.ts'
import { isResolutionUuid, validateResolutionEvent } from './exception-resolution.validation.ts'

// A8.7 §6 — a resolution event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked the five upstream read permissions (A8.1, A8.2, A8.3, A8.5, A8.6) and the event's own permission
//    (exceptionResolution.request or exceptionResolution.decide); the body is one event and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A8.1–A8.6 convention, so an A8.2
//    reassignment, an A8.5 decision, an A8.6 work event and an A8.7 write on one Claim are serialized); a busy Claim is
//    waited for outside the transaction within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the actor is judged before anything else: a requester must be the member to whom the A8.2 disposition presently
//    ASSIGNS the exception, eligible now and holding exceptionResolution.request (no Admin override); a decider must
//    hold exceptionResolution.decide now through their own membership and the exception must still be ASSIGNED; the
//    decider's membership and user must both differ from the requester's (D5);
// 5. the verified basis is read through its owners on the same client: the A8.6 work disposition must be
//    VERIFIED_INTERNAL_WORK with an EVIDENCE_SUPPORTED verification, sitting on exactly the plan the A8.5 owner reports
//    as APPROVED_FOR_PLANNING; the A8.3 history is re-read so an unverifiable investigation fails closed; the stored
//    resolution history is derived by the pure reducer against that basis; an inconsistent owner or resolution history
//    refuses the write (never repaired);
// 6. a request must name exactly the A8.6 verification (verification.workEventId) of this intake: another intake's or a
//    missing one is the same 404, one of this intake that is not its supported verification is 409; a decision must
//    name exactly the pending request and re-checks the request's recorded basis (D6);
// 7. exactly one event, numbered one more than the history, and one metadata-only audit are appended atomically; the
//    database guard re-checks time, coherence, the acting membership, the current assignment and the permission, the
//    verified basis on its approved plan, the pending request, independence, the terminal states and the sequence.
// There is no idempotency key: an exact repeat is refused by the history rules, and an unknown commit outcome is never
// retried blindly: it is reconciled against the committed history and answered 409 with what that history holds.
// RESOLVED_INTERNAL is an internal decision only: nothing is executed, corrected, closed, escalated or paid, and nothing
// upstream changes. RETURNED_FOR_REWORK is terminal in v1.

class ResolutionRefusalError extends Error {
  readonly code: ResolutionErrorCode
  constructor(code: ResolutionErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ResolutionErrorCode, message: string): never {
  throw new ResolutionRefusalError(code, message)
}

const invalid = (message: string): ResolutionResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const VERIFICATION_NOT_FOUND_MESSAGE = 'remediation work verification not found for this exception'
const NOT_ASSIGNEE_MESSAGE = 'only the current, eligible assignee of this exception holding the resolution request permission requests an internal resolution; nothing was recorded'
const NOT_INDEPENDENT_MESSAGE = 'a resolution request is decided only by another member holding the resolution decision permission now, never by its own requester; nothing was recorded'
const NOT_ASSIGNED_MESSAGE = 'the exception is not assigned now; a resolution is requested and decided only while the exception is assigned; nothing was recorded'
const NOT_VERIFIED_MESSAGE =
  "the named remediation work event is not this exception's independently verified (EVIDENCE_SUPPORTED) work on its approved plan; a resolution is requested only against it; nothing was recorded"
const INCONSISTENT_MESSAGE = "the exception's stored resolution history is inconsistent; nothing was derived or recorded"
const TRIAGE_UNREADABLE_MESSAGE = "the exception's triage history is inconsistent, so its assignment cannot be established; nothing was recorded"
const INVESTIGATION_UNREADABLE_MESSAGE = "the exception's investigation history is inconsistent, so its verified basis cannot be established; nothing was recorded"
const BASIS_UNREADABLE_MESSAGE = "the exception's remediation or remediation work history is inconsistent, so its verified basis cannot be established; nothing was recorded"

const MAX_RESOLUTION_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence) and the one decision per request refuse a competing writer; the retry re-reads the
// history and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): ResolutionErrorCode | null =>
  /exception_resolution_assignee/.test(message)
    ? 'EXCEPTION_RESOLUTION_NOT_ASSIGNEE'
    : /exception_resolution_reviewer/.test(message)
      ? 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT'
      : /exception_resolution_basis/.test(message)
        ? 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED'
        : /exception_resolution_(sequence|transition)/.test(message)
          ? 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED'
          : /exception_resolution_(time|coherence|member)|exception_resolution_events is append-only/.test(message)
            ? 'EXCEPTION_RESOLUTION_CONFLICT'
            : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// D7 — each reducer refusal answered as its own kind.
const CODE_OF_REFUSAL: Record<ResolutionRefusal, ResolutionErrorCode> = {
  SHAPE: 'EXCEPTION_RESOLUTION_CONFLICT',
  BASIS_NOT_VERIFIED: 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED',
  REVIEWER_NOT_INDEPENDENT: 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT',
  TRANSITION_REFUSED: 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED',
}

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: ResolutionEventRecord): ResolutionEventDto {
  return {
    resolutionEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as ResolutionEventCode,
    verificationEventId: record.verificationEventId,
    requestEventId: record.requestEventId,
    reasonCode: record.reasonCode as RequestReasonCode | null,
    decisionCode: record.decisionCode as DecisionCode | null,
    returnReasonCode: record.returnReasonCode as ReturnReasonCode | null,
    recordedByMembershipId: record.recordedByMembershipId,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- the parent, the basis, the actor and the history ------------------------------------------------------

// The parent intake among the Claim's A8.1 intakes on tx, or null. Another Claim's or tenant's intake is not there.
async function intakeOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ExceptionIntakeDto | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  return intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId) ?? null
}

const parentOfIntake = (intake: ExceptionIntakeDto): ResolutionParent => ({ exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId })

type BasisRead = { basis: VerifiedBasis | null; workEventIds: string[] }

// D4 — the intake's verified basis through its owners on tx: the A8.6 work disposition (its EVIDENCE_SUPPORTED
// verification) on exactly the plan the A8.5 disposition reports as APPROVED_FOR_PLANNING, as recorded (never recomputed
// from present permissions or source status). Also every A8.6 event id of the intake, so a request naming a work event of
// this intake that is not its supported verification is told apart from a foreign one. An owner history that does not
// agree with itself fails closed (null).
async function basisOf(claimId: string, parent: ResolutionParent, tx: DbClient): Promise<BasisRead | null> {
  const plan = await getRemediationDispositionOf(claimId, parent.exceptionIntakeId, tx)
  const work = await getWorkDispositionOf(claimId, parent.exceptionIntakeId, tx)
  const workHistory = await getWorkHistoryOf(claimId, parent.exceptionIntakeId, tx)
  if (!plan.ok || !work.ok || !workHistory.ok) return null
  const coherent = workHistory.value.items.every((item) => item.exceptionIntakeId === parent.exceptionIntakeId && item.organizationId === parent.organizationId && item.claimId === parent.claimId)
  if (!coherent) return null
  return { basis: verifiedBasisOf(work.value, plan.value), workEventIds: workHistory.value.items.map((item) => item.workEventId) }
}

async function historyOf(parent: ResolutionParent, basis: VerifiedBasis | null, tx: DbClient): Promise<{ records: ResolutionEventRecord[]; derived: ResolutionDerived } | null> {
  const records = await findResolutionEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveResolution(parent, basis, records)
  return derived.ok ? { records, derived: derived.value } : null
}

async function dispositionOf(claimId: string, parent: ResolutionParent, tx: DbClient): Promise<TriageDispositionDto> {
  const disposition = await getTriageDispositionOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok) return disposition.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_RESOLUTION_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
  return disposition.value
}

// The acting user's own membership of the organization, if its effective roles grant `permission` now; otherwise null.
async function membershipHolding(parent: ResolutionParent, actorUserId: string, permission: string, tx: DbClient): Promise<string | null> {
  const membership = await findActorMembership(parent.organizationId, actorUserId, tx)
  if (!membership) return null
  const access = await getEffectivePermissions(actorUserId, parent.organizationId)
  return access && access.membershipId === membership.id && access.permissions.includes(permission) ? membership.id : null
}

// D4 — a requester is the member to whom the A8.2 disposition presently assigns the exception, eligible now under the
// A8.2 policy, holding exceptionResolution.request now. Otherwise null.
async function actingRequester(claimId: string, parent: ResolutionParent, actorUserId: string, tx: DbClient): Promise<string | null> {
  const disposition = await dispositionOf(claimId, parent, tx)
  const membershipId = await membershipHolding(parent, actorUserId, REQUESTER_PERMISSION, tx)
  if (!membershipId) return null
  const { dispositionCode, assignedMemberId, assigneeCurrentlyEligible } = disposition
  return dispositionCode === 'ASSIGNED' && assignedMemberId === membershipId && assigneeCurrentlyEligible === true ? membershipId : null
}

// D5 — a decider holds exceptionResolution.decide now through their own membership, and the exception is still
// ASSIGNED. Independence from the requester is judged against the history, below.
async function actingDecider(claimId: string, parent: ResolutionParent, actorUserId: string, tx: DbClient): Promise<string> {
  const disposition = await dispositionOf(claimId, parent, tx)
  const membershipId = await membershipHolding(parent, actorUserId, DECIDER_PERMISSION, tx)
  if (!membershipId) return refuse('EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT', NOT_INDEPENDENT_MESSAGE)
  if (disposition.dispositionCode !== 'ASSIGNED') return refuse('EXCEPTION_RESOLUTION_TRANSITION_REFUSED', NOT_ASSIGNED_MESSAGE)
  return membershipId
}

// The A8.3 history of this intake, read through its owner on tx. An inconsistent investigation fails closed.
async function investigationOf(claimId: string, parent: ResolutionParent, tx: DbClient): Promise<void> {
  const history = await getInvestigationHistoryOf(claimId, parent.exceptionIntakeId, tx)
  if (!history.ok) refuse(history.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'EXCEPTION_RESOLUTION_CONFLICT', history.code === 'NOT_FOUND' ? NOT_FOUND_MESSAGE : INVESTIGATION_UNREADABLE_MESSAGE)
}

// ---- record (§6, POST resolution-events) -----------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function recordOnTransaction(
  claimId: string,
  exceptionIntakeId: string,
  request: ResolutionEventRequest,
  actorUserId: string,
  tx: DbClient,
  attempted?: { event: AttemptedResolutionEvent | null },
): Promise<ResolutionEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionResolution.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const intake = await intakeOf(claimId, exceptionIntakeId, tx)
  if (!intake) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = parentOfIntake(intake)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_RESOLUTION_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the actor, before anything else is judged.
  const membershipId =
    request.eventCode === 'REQUEST_INTERNAL_RESOLUTION'
      ? ((await actingRequester(claimId, parent, actorUserId, tx)) ?? refuse('EXCEPTION_RESOLUTION_NOT_ASSIGNEE', NOT_ASSIGNEE_MESSAGE))
      : await actingDecider(claimId, parent, actorUserId, tx)

  // 5 — the verified basis through its A8.5 and A8.6 owners (and the A8.3 history), then the stored resolution history.
  await investigationOf(claimId, parent, tx)
  const basisRead = (await basisOf(claimId, parent, tx)) ?? refuse('EXCEPTION_RESOLUTION_CONFLICT', BASIS_UNREADABLE_MESSAGE)
  const history = await historyOf(parent, basisRead.basis, tx)
  if (!history) return refuse('EXCEPTION_RESOLUTION_CONFLICT', INCONSISTENT_MESSAGE)

  // 6 — the cited verification through its owner, then the next step (independence and the basis re-check included).
  let shape: ResolutionEventShape
  if (request.eventCode === 'REQUEST_INTERNAL_RESOLUTION') {
    if (!basisRead.workEventIds.includes(request.verificationEventId)) return refuse('NOT_FOUND', VERIFICATION_NOT_FOUND_MESSAGE)
    shape = {
      eventCode: request.eventCode,
      verificationEventId: request.verificationEventId,
      requestEventId: null,
      reasonCode: request.reasonCode,
      decisionCode: null,
      returnReasonCode: null,
      recordedByMembershipId: membershipId,
      recordedByUserId: actorUserId,
    }
  } else {
    shape = {
      eventCode: request.eventCode,
      verificationEventId: null,
      requestEventId: request.requestEventId,
      reasonCode: null,
      decisionCode: request.decisionCode,
      returnReasonCode: request.returnReasonCode,
      recordedByMembershipId: membershipId,
      recordedByUserId: actorUserId,
    }
  }
  const next = applyResolutionEvent(history.derived, basisRead.basis, shape)
  if (!next.ok) return refuse(CODE_OF_REFUSAL[next.refusal], next.refusal === 'BASIS_NOT_VERIFIED' && request.eventCode === 'REQUEST_INTERNAL_RESOLUTION' ? NOT_VERIFIED_MESSAGE : `${next.detail}; nothing was recorded`)

  // 7 — one event and one business audit, atomically.
  const sequence = next.derived.lastSequence
  if (attempted) attempted.event = { ...shape, sequence }
  const event = await insertResolutionEvent({ ...parent, ...shape, contractVersion: RESOLUTION_CONTRACT_VERSION, sequence }, tx)
  await concurrencyProbe('exceptionResolution.inserted')
  // Metadata only: ids, contract, sequence, the controlled codes, the verification and request pointers, the acting
  // membership and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_resolution.recorded',
      entityType: 'EXCEPTION_RESOLUTION_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        resolutionEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        verificationEventId: event.verificationEventId,
        requestEventId: event.requestEventId,
        reasonCode: event.reasonCode,
        decisionCode: event.decisionCode,
        returnReasonCode: event.returnReasonCode,
        recordedByMembershipId: event.recordedByMembershipId,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionResolution.audited')
  return toEventDto(event)
}

// An unknown outcome is reconciled against the exact committed history on a fresh read: the event at the attempted
// sequence either is exactly this request (membership, actor and every controlled field), is another event, or does
// not exist. Nothing is retried and success is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedResolutionEvent | null): Promise<ResolutionResult<never>> {
  const conflict = (message: string): ResolutionResult<never> => ({ ok: false, code: 'EXCEPTION_RESOLUTION_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findResolutionEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's resolution history before requesting again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this event at sequence ${attempted.sequence} (resolution event ${reconciled.resolutionEventId}); it was not requested again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this request was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): ResolutionResult<ResolutionEventRequest> => {
  if (!isResolutionUuid(claimId)) return invalid('invalid claim id')
  if (!isResolutionUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateResolutionEvent(body)
  return event.ok ? { ok: true, value: event.value } : { ok: false, code: event.code, message: event.message }
}

export async function recordResolutionEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<ResolutionResult<ResolutionEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedResolutionEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof ResolutionRefusalError) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_RESOLUTION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_RESOLUTION_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_RESOLUTION_CONFLICT', message: 'concurrent resolution requests for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the resolution event; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The event on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordResolutionEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<ResolutionResult<ResolutionEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof ResolutionRefusalError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§6) --------------------------------------------------------------------------------------

async function readParentAndHistory(
  claimId: string,
  exceptionIntakeId: string,
  tx: DbClient,
): Promise<ResolutionResult<{ parent: ResolutionParent; basis: VerifiedBasis | null; records: ResolutionEventRecord[]; derived: ResolutionDerived }>> {
  if (!isResolutionUuid(claimId)) return invalid('invalid claim id')
  if (!isResolutionUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const intake = await intakeOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!intake) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = parentOfIntake(intake)
  const basisRead = parent.organizationId === claim.organizationId ? await basisOf(claimId.toLowerCase(), parent, tx) : null
  const history = basisRead ? await historyOf(parent, basisRead.basis, tx) : null
  if (!basisRead || !history) return { ok: false, code: 'EXCEPTION_RESOLUTION_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, basis: basisRead.basis, ...history } }
}

// One intake's history on the CALLER's transaction — what later owners consult. Nothing is written.
export async function getResolutionHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ResolutionResult<ResolutionHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: { contractVersion: RESOLUTION_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() },
  }
}

// One intake's derived resolution disposition on the CALLER's transaction — the reader a future owner consults. It
// opens no transaction of its own and writes nothing. The A8.1–A8.6 records stay their own sources of truth and are not
// copied. A historical decision is never recomputed from present permissions or present source status.
export async function getResolutionDispositionOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ResolutionResult<ResolutionDispositionDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { derived, records, parent, basis } = read.value
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: RESOLUTION_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      state: derived.state,
      verificationEventId: basis?.verificationEventId ?? null,
      request: derived.request,
      decision: derived.decision,
      eventCount: records.length,
      lastSequence: records.length > 0 ? derived.lastSequence : null,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getResolutionHistory(claimId: string, exceptionIntakeId: string): Promise<ResolutionResult<ResolutionHistoryDto>> {
  if (!isResolutionUuid(claimId) || !isResolutionUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getResolutionHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getResolutionDisposition(claimId: string, exceptionIntakeId: string): Promise<ResolutionResult<ResolutionDispositionDto>> {
  if (!isResolutionUuid(claimId) || !isResolutionUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getResolutionDispositionOf(claimId, exceptionIntakeId, tx))
}
