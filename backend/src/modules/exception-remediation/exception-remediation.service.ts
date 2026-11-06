import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.5 consumes, unchanged: the A6.7 Claim ownership path, the A8.1 intakes of a Claim, the A8.2 triage
// disposition of an intake and the A8.3 investigation history of an intake on the caller's transaction, the A1
// effective permissions of a member, and the database's own evaluation instant.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import type { ExceptionIntakeDto } from '../exception-intake/exception-intake.types.ts'
import { getTriageDispositionOf } from '../exception-triage/exception-triage.service.ts'
import type { TriageDispositionDto } from '../exception-triage/exception-triage.types.ts'
import { getInvestigationHistoryOf } from '../exception-investigation/exception-investigation.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyRemediationEvent, deriveRemediation, reconcileAttempt } from './exception-remediation.reducer.ts'
import { findActorMembership, findRemediationEventsOfIntake, insertRemediationEvent, type RemediationEventRecord } from './exception-remediation.repository.ts'
import {
  type ActionCode,
  type AttemptedRemediationEvent,
  type DecisionCode,
  PROPOSER_PERMISSION,
  type RationaleCode,
  REMEDIATION_CONTRACT_VERSION,
  REVIEWER_PERMISSION,
  type RemediationDerived,
  type RemediationDispositionDto,
  type RemediationErrorCode,
  type RemediationEventCode,
  type RemediationEventDto,
  type RemediationEventRequest,
  type RemediationEventShape,
  type RemediationHistoryDto,
  type RemediationParent,
  type RemediationResult,
  type ReviewReasonCode,
} from './exception-remediation.types.ts'
import { isRemediationUuid, validateRemediationEvent } from './exception-remediation.validation.ts'

// A8.5 §5 — a remediation event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked exceptionIntake.read, exceptionTriage.read, exceptionInvestigation.read and the event's own permission
//    (exceptionRemediation.propose or exceptionRemediation.review); the body is one event and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A8.1–A8.3 convention, so an A8.2
//    reassignment and an A8.5 write on one Claim are serialized); a busy Claim is waited for outside the transaction
//    within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the actor is judged before anything else: a proposer must be the member to whom the A8.2 disposition presently
//    ASSIGNS the exception, eligible now and holding exceptionRemediation.propose (no Admin override); a reviewer must
//    hold exceptionRemediation.review now through their own membership, the exception must still be ASSIGNED, and the
//    reviewer's membership and user must both differ from the outstanding proposal's author (no self-review, no proxy);
// 5. the intake's stored remediation history is derived by the pure reducer; an inconsistent history refuses the
//    write (never repaired);
// 6. a proposal's finding is verified through the A8.3 owner: an A8.3 event of exactly this intake, Claim and
//    organization (another's or a missing one is the same 404) that is a RECORD_FINDING (a link alone supports no
//    proposal: 409); a review re-reads the A8.3 history so an unverifiable investigation fails closed;
// 7. exactly one event, numbered one more than the history, and one metadata-only audit are appended atomically; the
//    database guard re-checks time, coherence, the acting membership, the current assignment and the permission, the
//    finding, the outstanding proposal, independence and the sequence.
// There is no idempotency key: an exact repeat is refused by the history rules, and an unknown commit outcome is never
// retried blindly: it is reconciled against the committed history and answered 409 with what that history holds.
// Nothing is executed, corrected, resolved, closed, escalated or paid, and nothing upstream changes.

class RemediationRefusal extends Error {
  readonly code: RemediationErrorCode
  constructor(code: RemediationErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: RemediationErrorCode, message: string): never {
  throw new RemediationRefusal(code, message)
}

const invalid = (message: string): RemediationResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const FINDING_NOT_FOUND_MESSAGE = 'investigation finding not found for this exception'
const NOT_ASSIGNEE_MESSAGE = 'only the current, eligible assignee of this exception holding the proposal permission proposes a remediation action; nothing was recorded'
const NOT_INDEPENDENT_MESSAGE = "a proposal is reviewed only by another member holding the review permission now, never by the proposal's author; nothing was recorded"
const NOT_ASSIGNED_MESSAGE = 'the exception is not assigned now; a proposal is proposed and reviewed only while the exception is assigned; nothing was recorded'
const INCONSISTENT_MESSAGE = "the exception's stored remediation history is inconsistent; nothing was derived or recorded"
const TRIAGE_UNREADABLE_MESSAGE = "the exception's triage history is inconsistent, so its assignment cannot be established; nothing was recorded"
const INVESTIGATION_UNREADABLE_MESSAGE = "the exception's investigation history is inconsistent, so the finding cannot be verified; nothing was recorded"

const MAX_REMEDIATION_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence) and the one review per proposal refuse a competing writer; the retry re-reads the
// history and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): RemediationErrorCode | null =>
  /exception_remediation_assignee/.test(message)
    ? 'EXCEPTION_REMEDIATION_NOT_ASSIGNEE'
    : /exception_remediation_reviewer/.test(message)
      ? 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT'
      : /exception_remediation_(sequence|transition|finding|repeat)/.test(message)
        ? 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED'
        : /exception_remediation_(time|coherence|member)|exception_remediation_events is append-only/.test(message)
          ? 'EXCEPTION_REMEDIATION_CONFLICT'
          : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: RemediationEventRecord): RemediationEventDto {
  return {
    remediationEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as RemediationEventCode,
    actionCode: record.actionCode as ActionCode | null,
    findingEventId: record.findingEventId,
    rationaleCode: record.rationaleCode as RationaleCode | null,
    proposalEventId: record.proposalEventId,
    decisionCode: record.decisionCode as DecisionCode | null,
    reviewReasonCode: record.reviewReasonCode as ReviewReasonCode | null,
    recordedByMembershipId: record.recordedByMembershipId,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- the parent, the actor and the history ---------------------------------------------------------------

// The parent intake among the Claim's A8.1 intakes on tx, or null. Another Claim's or tenant's intake is not there.
async function intakeOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ExceptionIntakeDto | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  return intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId) ?? null
}

const parentOfIntake = (intake: ExceptionIntakeDto): RemediationParent => ({ exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId })

async function historyOf(parent: RemediationParent, tx: DbClient): Promise<{ records: RemediationEventRecord[]; derived: RemediationDerived } | null> {
  const records = await findRemediationEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveRemediation(parent, records)
  return derived.ok ? { records, derived: derived.value } : null
}

async function dispositionOf(claimId: string, parent: RemediationParent, tx: DbClient): Promise<TriageDispositionDto> {
  const disposition = await getTriageDispositionOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok) return disposition.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_REMEDIATION_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
  return disposition.value
}

// The acting user's own membership of the organization, if its effective roles grant `permission` now; otherwise null.
async function membershipHolding(parent: RemediationParent, actorUserId: string, permission: string, tx: DbClient): Promise<string | null> {
  const membership = await findActorMembership(parent.organizationId, actorUserId, tx)
  if (!membership) return null
  const access = await getEffectivePermissions(actorUserId, parent.organizationId)
  return access && access.membershipId === membership.id && access.permissions.includes(permission) ? membership.id : null
}

// §4 — a proposer is the member to whom the A8.2 disposition presently assigns the exception, eligible now under the
// A8.2 policy, holding exceptionRemediation.propose now. Otherwise null.
async function actingProposer(claimId: string, parent: RemediationParent, actorUserId: string, tx: DbClient): Promise<string | null> {
  const disposition = await dispositionOf(claimId, parent, tx)
  const membershipId = await membershipHolding(parent, actorUserId, PROPOSER_PERMISSION, tx)
  if (!membershipId) return null
  const { dispositionCode, assignedMemberId, assigneeCurrentlyEligible } = disposition
  return dispositionCode === 'ASSIGNED' && assignedMemberId === membershipId && assigneeCurrentlyEligible === true ? membershipId : null
}

// §4 — a reviewer holds exceptionRemediation.review now through their own membership, and the exception is still
// ASSIGNED (R3: a planning decision is taken only while somebody owns the exception). Independence from the proposal's
// author is judged against the history, below.
async function actingReviewer(claimId: string, parent: RemediationParent, actorUserId: string, tx: DbClient): Promise<string> {
  const disposition = await dispositionOf(claimId, parent, tx)
  const membershipId = await membershipHolding(parent, actorUserId, REVIEWER_PERMISSION, tx)
  if (!membershipId) return refuse('EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT', NOT_INDEPENDENT_MESSAGE)
  if (disposition.dispositionCode !== 'ASSIGNED') return refuse('EXCEPTION_REMEDIATION_TRANSITION_REFUSED', NOT_ASSIGNED_MESSAGE)
  return membershipId
}

// §4 — the A8.3 history of this intake, read through its owner on tx. An inconsistent investigation fails closed.
async function investigationOf(claimId: string, parent: RemediationParent, tx: DbClient) {
  const history = await getInvestigationHistoryOf(claimId, parent.exceptionIntakeId, tx)
  if (!history.ok) return history.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_REMEDIATION_CONFLICT', INVESTIGATION_UNREADABLE_MESSAGE)
  return history.value
}

// §4 — the finding a proposal names: an A8.3 event of exactly this intake, organization and Claim (otherwise the same
// 404 as a missing one) that is a RECORD_FINDING (a link alone supports no proposal: 409).
async function verifiedFinding(claimId: string, parent: RemediationParent, findingEventId: string, tx: DbClient): Promise<void> {
  const investigation = await investigationOf(claimId, parent, tx)
  const event = investigation.items.find((item) => item.investigationEventId === findingEventId)
  if (!event || event.exceptionIntakeId !== parent.exceptionIntakeId || event.organizationId !== parent.organizationId || event.claimId !== parent.claimId) refuse('NOT_FOUND', FINDING_NOT_FOUND_MESSAGE)
  if (event.eventCode !== 'RECORD_FINDING') refuse('EXCEPTION_REMEDIATION_TRANSITION_REFUSED', 'the named investigation event is not a recorded finding; an evidence link alone supports no proposal; nothing was recorded')
}

// ---- record (§5, POST remediation-events) ---------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function recordOnTransaction(claimId: string, exceptionIntakeId: string, request: RemediationEventRequest, actorUserId: string, tx: DbClient, attempted?: { event: AttemptedRemediationEvent | null }): Promise<RemediationEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionRemediation.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const intake = await intakeOf(claimId, exceptionIntakeId, tx)
  if (!intake) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = parentOfIntake(intake)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_REMEDIATION_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the actor, before anything else is judged.
  const membershipId =
    request.eventCode === 'PROPOSE_ACTION'
      ? ((await actingProposer(claimId, parent, actorUserId, tx)) ?? refuse('EXCEPTION_REMEDIATION_NOT_ASSIGNEE', NOT_ASSIGNEE_MESSAGE))
      : await actingReviewer(claimId, parent, actorUserId, tx)

  // 5 — the stored remediation history.
  const history = await historyOf(parent, tx)
  if (!history) return refuse('EXCEPTION_REMEDIATION_CONFLICT', INCONSISTENT_MESSAGE)

  // 6 — the finding through its owner, independence from the author, then the next step.
  const shape: RemediationEventShape =
    request.eventCode === 'PROPOSE_ACTION'
      ? { eventCode: request.eventCode, actionCode: request.actionCode, findingEventId: request.findingEventId, rationaleCode: request.rationaleCode, proposalEventId: null, decisionCode: null, reviewReasonCode: null, recordedByMembershipId: membershipId, recordedByUserId: actorUserId }
      : { eventCode: request.eventCode, actionCode: null, findingEventId: null, rationaleCode: null, proposalEventId: request.proposalEventId, decisionCode: request.decisionCode, reviewReasonCode: request.reviewReasonCode, recordedByMembershipId: membershipId, recordedByUserId: actorUserId }
  if (request.eventCode === 'PROPOSE_ACTION') await verifiedFinding(claimId, parent, request.findingEventId, tx)
  else {
    await investigationOf(claimId, parent, tx)
    const pending = history.derived.pendingProposal
    if (pending && (pending.proposedByMembershipId === membershipId || pending.proposedByUserId === actorUserId)) refuse('EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT', NOT_INDEPENDENT_MESSAGE)
  }
  const next = applyRemediationEvent(history.derived, shape)
  if (!next.ok) return refuse('EXCEPTION_REMEDIATION_TRANSITION_REFUSED', `${next.detail}; nothing was recorded`)

  // 7 — one event and one business audit, atomically.
  const sequence = next.derived.lastSequence
  if (attempted) attempted.event = { ...shape, sequence }
  const event = await insertRemediationEvent({ ...parent, ...shape, contractVersion: REMEDIATION_CONTRACT_VERSION, sequence }, tx)
  await concurrencyProbe('exceptionRemediation.inserted')
  // Metadata only: ids, contract, sequence, the controlled codes, the finding and proposal pointers, the acting
  // membership and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_remediation.recorded',
      entityType: 'EXCEPTION_REMEDIATION_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        remediationEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        actionCode: event.actionCode,
        findingEventId: event.findingEventId,
        rationaleCode: event.rationaleCode,
        proposalEventId: event.proposalEventId,
        decisionCode: event.decisionCode,
        reviewReasonCode: event.reviewReasonCode,
        recordedByMembershipId: event.recordedByMembershipId,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionRemediation.audited')
  return toEventDto(event)
}

// An unknown outcome is reconciled against the exact committed history on a fresh read: the event at the attempted
// sequence either is exactly this request (membership, actor and every controlled field), is another event, or does
// not exist. Nothing is retried and success is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedRemediationEvent | null): Promise<RemediationResult<never>> {
  const conflict = (message: string): RemediationResult<never> => ({ ok: false, code: 'EXCEPTION_REMEDIATION_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findRemediationEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's remediation history before requesting again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this event at sequence ${attempted.sequence} (remediation event ${reconciled.remediationEventId}); it was not requested again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this request was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): RemediationResult<RemediationEventRequest> => {
  if (!isRemediationUuid(claimId)) return invalid('invalid claim id')
  if (!isRemediationUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateRemediationEvent(body)
  return event.ok ? { ok: true, value: event.value } : invalid(event.message)
}

export async function recordRemediationEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<RemediationResult<RemediationEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedRemediationEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof RemediationRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_REMEDIATION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_REMEDIATION_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_REMEDIATION_CONFLICT', message: 'concurrent remediation requests for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the remediation event; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The event on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordRemediationEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<RemediationResult<RemediationEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof RemediationRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§6) --------------------------------------------------------------------------------------

async function readParentAndHistory(
  claimId: string,
  exceptionIntakeId: string,
  tx: DbClient,
): Promise<RemediationResult<{ parent: RemediationParent; records: RemediationEventRecord[]; derived: RemediationDerived }>> {
  if (!isRemediationUuid(claimId)) return invalid('invalid claim id')
  if (!isRemediationUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const intake = await intakeOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!intake) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = parentOfIntake(intake)
  const history = parent.organizationId === claim.organizationId ? await historyOf(parent, tx) : null
  if (!history) return { ok: false, code: 'EXCEPTION_REMEDIATION_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, ...history } }
}

// One intake's history on the CALLER's transaction — what later A8 owners consult. Nothing is written.
export async function getRemediationHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<RemediationResult<RemediationHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return { ok: true, value: { contractVersion: REMEDIATION_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() } }
}

// One intake's derived remediation disposition on the CALLER's transaction — the reader a future owner consults. It
// opens no transaction of its own and writes nothing. The A8.1 intake, the A8.2 disposition and the A8.3 history stay
// their own sources of truth and are not copied here.
export async function getRemediationDispositionOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<RemediationResult<RemediationDispositionDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { derived, records, parent } = read.value
  const evaluatedAt = await readTransactionTimestamp(tx)
  const latestDecision = derived.decisions[derived.decisions.length - 1] ?? null
  return {
    ok: true,
    value: {
      contractVersion: REMEDIATION_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      state: derived.state,
      pendingProposal: derived.pendingProposal,
      latestDecision,
      approvedProposalEventId: derived.state === 'APPROVED_FOR_PLANNING' && latestDecision ? latestDecision.proposalEventId : null,
      proposalCount: derived.proposals.length,
      eventCount: records.length,
      lastSequence: records.length > 0 ? derived.lastSequence : null,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getRemediationHistory(claimId: string, exceptionIntakeId: string): Promise<RemediationResult<RemediationHistoryDto>> {
  if (!isRemediationUuid(claimId) || !isRemediationUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getRemediationHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getRemediationDisposition(claimId: string, exceptionIntakeId: string): Promise<RemediationResult<RemediationDispositionDto>> {
  if (!isRemediationUuid(claimId) || !isRemediationUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getRemediationDispositionOf(claimId, exceptionIntakeId, tx))
}
