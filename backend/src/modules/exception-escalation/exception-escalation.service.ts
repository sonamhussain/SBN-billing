import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.8 consumes, unchanged: the A6.7 Claim ownership path, the A8.1 intakes of a Claim, the A8.2 triage
// disposition and history, the A8.3 investigation history, the A8.5 remediation disposition, the A8.6 work history,
// the A8.7 resolution disposition and history of an intake on the caller's transaction, the A1 effective permissions
// of a member, and the database's own evaluation instant.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import type { ExceptionIntakeDto } from '../exception-intake/exception-intake.types.ts'
import { getTriageDispositionOf, getTriageHistoryOf } from '../exception-triage/exception-triage.service.ts'
import type { TriageDispositionDto } from '../exception-triage/exception-triage.types.ts'
import { getInvestigationHistoryOf } from '../exception-investigation/exception-investigation.service.ts'
import { getRemediationDispositionOf, getRemediationHistoryOf } from '../exception-remediation/exception-remediation.service.ts'
import { getWorkHistoryOf } from '../exception-remediation-work/exception-remediation-work.service.ts'
import { getResolutionDispositionOf, getResolutionHistoryOf } from '../exception-resolution/exception-resolution.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyEscalationEvent, deriveEscalation, reconcileAttempt, upstreamRefusal } from './exception-escalation.reducer.ts'
import { findActorMembership, findEscalationEventsOfIntake, findMembershipById, insertEscalationEvent, type EscalationEventRecord } from './exception-escalation.repository.ts'
import {
  ASSIGNEE_PERMISSION,
  type AttemptedEscalationEvent,
  ESCALATION_CONTRACT_VERSION,
  type EscalationDerived,
  type EscalationDispositionDto,
  type EscalationErrorCode,
  type EscalationEventCode,
  type EscalationEventDto,
  type EscalationEventRequest,
  type EscalationEventShape,
  type EscalationHistoryDto,
  type EscalationParent,
  type EscalationReasonCode,
  type EscalationRefusal,
  type EscalationResult,
  type FollowupCode,
  HANDLE_PERMISSION,
  PARENT_READ_PERMISSIONS,
  RAISE_PERMISSION,
  type ReturnReasonCode,
  REVIEW_PERMISSION,
  type SourceEventKind,
} from './exception-escalation.types.ts'
import { isEscalationUuid, validateEscalationEvent } from './exception-escalation.validation.ts'

// A8.8 §6 — an escalation event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked the six upstream read permissions (A8.1, A8.2, A8.3, A8.5, A8.6, A8.7) and the event's own permission
//    (raise, handle or review); the body is one event and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A8.1–A8.7 convention, so an A8.2
//    reassignment, an A8.7 decision and an A8.8 write on one Claim are serialized); a busy Claim is waited for outside
//    the transaction within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the actor's own membership of the organization is established first, and an escalator must be the member to whom
//    the A8.2 disposition presently ASSIGNS the exception, eligible now and holding exceptionEscalation.raise;
// 5. the exception must be ASSIGNED now (D4); the A8.3, A8.5, A8.6 and A8.7 owners are read on the same client (an
//    inconsistent owner history fails closed), and A8.7 must permit the write (D1: nothing while a resolution request
//    awaits a decision or once the exception is RESOLVED_INTERNAL); the stored escalation history is derived by the pure
//    reducer (an inconsistent history refuses the write, never repaired);
// 6. the event's own references are resolved: a nominated member of another organization or none is the same 404, as
//    is a cited source that is no record of this intake; a cited record of this intake that is not an A8.3 or A8.6 event
//    is UNSUPPORTED_REFERENCE; the source kind is the server's, from the owner record that holds the id; then the
//    reducer judges the step (order, the nominated member, duplicates, independence), and the actor's and the target's
//    present eligibility is checked (D3: handle and the six reads; never the current assignee for an acknowledgement or
//    follow-up; a returning reviewer holds review and is never the current assignee);
// 7. exactly one event, numbered one more than the history, and one metadata-only audit are appended atomically; the
//    database guard re-checks time, coherence, the acting membership, the assignment, the A8.7 state, every actor rule,
//    the target's eligibility, the exact source, independence, the terminal state and the sequence.
// There is no idempotency key: an exact repeat is refused by the history rules, and an unknown commit outcome is never
// retried blindly: it is reconciled against the committed history and answered 409 with what that history holds.
// Escalation is an internal handoff only: nothing is resolved, closed, reassigned, executed, corrected or paid, and
// nothing upstream changes. RETURNED_TO_OWNER is terminal in v1.

class EscalationRefusalError extends Error {
  readonly code: EscalationErrorCode
  constructor(code: EscalationErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: EscalationErrorCode, message: string): never {
  throw new EscalationRefusalError(code, message)
}

const invalid = (message: string): EscalationResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const MEMBER_NOT_FOUND_MESSAGE = 'nominated member not found in this organization'
const SOURCE_NOT_FOUND_MESSAGE = 'cited source record not found for this exception'
const UNSUPPORTED_MESSAGE =
  'the cited record of this exception is not a source v1 accepts (only an A8.3 evidence link or finding, or an A8.6 work report or verification, of the same exception); nothing was recorded'
const NOT_ASSIGNEE_MESSAGE = 'only the current, eligible assignee of this exception holding the escalation raise permission escalates it; nothing was recorded'
const NO_MEMBERSHIP_MESSAGE = 'the actor has no membership of the owning organization; nothing was recorded'
const TARGET_NOT_ELIGIBLE_MESSAGE =
  'the nominated member is not eligible now (the escalation handle permission and the six upstream read permissions, and never the current assignee); nothing was recorded'
const HANDLER_NOT_ELIGIBLE_MESSAGE =
  'the nominated member must still hold the escalation handle permission and the six upstream read permissions, and must not be the current assignee; nothing was recorded'
const REVIEWER_MESSAGE = 'an escalation is returned only by a member holding the escalation review permission now who is not the current assignee; nothing was recorded'
const NOT_ASSIGNED_MESSAGE = 'the exception is not assigned now; an escalation event is recorded only while the exception is assigned; nothing was recorded'
const INCONSISTENT_MESSAGE = "the exception's stored escalation history is inconsistent; nothing was derived or recorded"
const TRIAGE_UNREADABLE_MESSAGE = "the exception's triage history is inconsistent, so its assignment cannot be established; nothing was recorded"
const UPSTREAM_UNREADABLE_MESSAGE = "the exception's investigation, remediation, remediation work or resolution history is inconsistent; nothing was recorded"

const MAX_ESCALATION_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence), the one escalation, acknowledgement and return per intake, and the one (code, source)
// per follow-up refuse a competing writer; the retry re-reads the history and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): EscalationErrorCode | null =>
  /exception_escalation_assignee/.test(message)
    ? 'EXCEPTION_ESCALATION_NOT_ASSIGNEE'
    : /exception_escalation_target/.test(message)
      ? 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE'
      : /exception_escalation_independence/.test(message)
        ? 'EXCEPTION_ESCALATION_NOT_INDEPENDENT'
        : /exception_escalation_source/.test(message)
          ? 'UNSUPPORTED_REFERENCE'
          : /exception_escalation_(sequence|transition)/.test(message)
            ? 'EXCEPTION_ESCALATION_TRANSITION_REFUSED'
            : /exception_escalation_(time|coherence|member)|exception_escalation_events is append-only/.test(message)
              ? 'EXCEPTION_ESCALATION_CONFLICT'
              : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// D7 — each reducer refusal answered as its own kind.
const CODE_OF_REFUSAL: Record<EscalationRefusal, EscalationErrorCode> = {
  SHAPE: 'EXCEPTION_ESCALATION_CONFLICT',
  TARGET_NOT_ELIGIBLE: 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE',
  NOT_INDEPENDENT: 'EXCEPTION_ESCALATION_NOT_INDEPENDENT',
  TRANSITION_REFUSED: 'EXCEPTION_ESCALATION_TRANSITION_REFUSED',
}

// The owner event code of each A8.3 and A8.6 event a follow-up may cite, as the stored source kind (D5/D6).
const KIND_OF_INVESTIGATION_EVENT: Record<string, SourceEventKind> = { LINK_EVIDENCE_REFERENCE: 'INVESTIGATION_EVIDENCE_LINK', RECORD_FINDING: 'INVESTIGATION_FINDING' }
const KIND_OF_WORK_EVENT: Record<string, SourceEventKind> = { RECORD_WORK_REPORT: 'WORK_REPORT', VERIFY_WORK_REPORT: 'WORK_VERIFICATION' }

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: EscalationEventRecord): EscalationEventDto {
  return {
    escalationEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as EscalationEventCode,
    reasonCode: record.reasonCode as EscalationReasonCode | null,
    targetMemberId: record.targetMemberId,
    referencedEscalationEventId: record.escalationEventId,
    acknowledgementEventId: record.acknowledgementEventId,
    followupCode: record.followupCode as FollowupCode | null,
    sourceEventId: record.sourceEventId,
    sourceEventKind: record.sourceEventKind as SourceEventKind | null,
    returnReasonCode: record.returnReasonCode as ReturnReasonCode | null,
    recordedByMembershipId: record.recordedByMembershipId,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- the parent, the owners, the actors and the history ------------------------------------------------------

// The parent intake among the Claim's A8.1 intakes on tx, or null. Another Claim's or tenant's intake is not there.
async function intakeOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ExceptionIntakeDto | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  return intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId) ?? null
}

const parentOfIntake = (intake: ExceptionIntakeDto): EscalationParent => ({ exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId })

async function historyOf(parent: EscalationParent, tx: DbClient): Promise<{ records: EscalationEventRecord[]; derived: EscalationDerived } | null> {
  const records = await findEscalationEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveEscalation(parent, records)
  return derived.ok ? { records, derived: derived.value } : null
}

async function dispositionOf(claimId: string, parent: EscalationParent, tx: DbClient): Promise<TriageDispositionDto> {
  const disposition = await getTriageDispositionOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok) return disposition.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_ESCALATION_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
  return disposition.value
}

// The permissions a membership's effective roles grant now (A1's own view), or null when the user has no membership of
// the organization or the view is of another membership.
async function permissionsOf(membershipId: string, userId: string, organizationId: string): Promise<string[] | null> {
  const access = await getEffectivePermissions(userId, organizationId)
  return access && access.membershipId === membershipId ? access.permissions : null
}

// D3 — an eligible handler holds exceptionEscalation.handle and all six upstream reads now.
const HANDLER_PERMISSIONS = [HANDLE_PERMISSION, ...PARENT_READ_PERMISSIONS]
const holdsAll = (permissions: string[] | null, required: readonly string[]) => !!permissions && required.every((permission) => permissions.includes(permission))

type UpstreamRead = { sources: Map<string, SourceEventKind>; otherRecordIds: Set<string> }

// §6 — the A8.3, A8.5, A8.6 and A8.7 owners of this intake on tx, read through their accepted readers (never their
// tables), and A8.7's gate on this event (D1). The returned map is every A8.3/A8.6 event id of the intake with the kind a
// follow-up stores; `otherRecordIds` are the intake's other A8-owned records (its own id, its A8.2, A8.5, A8.7 and A8.8
// events), which a follow-up may not cite (UNSUPPORTED_REFERENCE). An owner history that does not agree with itself
// fails closed.
async function upstreamOf(claimId: string, parent: EscalationParent, eventCode: string, tx: DbClient): Promise<UpstreamRead> {
  const investigation = await getInvestigationHistoryOf(claimId, parent.exceptionIntakeId, tx)
  const plan = await getRemediationDispositionOf(claimId, parent.exceptionIntakeId, tx)
  const planHistory = await getRemediationHistoryOf(claimId, parent.exceptionIntakeId, tx)
  const work = await getWorkHistoryOf(claimId, parent.exceptionIntakeId, tx)
  const resolution = await getResolutionDispositionOf(claimId, parent.exceptionIntakeId, tx)
  const resolutionHistory = await getResolutionHistoryOf(claimId, parent.exceptionIntakeId, tx)
  const triage = await getTriageHistoryOf(claimId, parent.exceptionIntakeId, tx)
  if (!investigation.ok || !plan.ok || !planHistory.ok || !work.ok || !resolution.ok || !resolutionHistory.ok || !triage.ok)
    return refuse('EXCEPTION_ESCALATION_CONFLICT', UPSTREAM_UNREADABLE_MESSAGE)
  const sameParent = (item: { exceptionIntakeId: string; organizationId: string; claimId: string }) =>
    item.exceptionIntakeId === parent.exceptionIntakeId && item.organizationId === parent.organizationId && item.claimId === parent.claimId
  if (![investigation.value.items, planHistory.value.items, work.value.items, resolutionHistory.value.items].every((items) => items.every(sameParent)))
    return refuse('EXCEPTION_ESCALATION_CONFLICT', UPSTREAM_UNREADABLE_MESSAGE)
  const gate = upstreamRefusal(eventCode, resolution.value.state)
  if (gate) return refuse('EXCEPTION_ESCALATION_TRANSITION_REFUSED', `${gate}; nothing was recorded`)
  const sources = new Map<string, SourceEventKind>()
  for (const item of investigation.value.items) {
    const kind = KIND_OF_INVESTIGATION_EVENT[item.eventCode]
    if (kind) sources.set(item.investigationEventId, kind)
  }
  for (const item of work.value.items) {
    const kind = KIND_OF_WORK_EVENT[item.eventCode]
    if (kind) sources.set(item.workEventId, kind)
  }
  const otherRecordIds = new Set<string>([
    parent.exceptionIntakeId,
    ...triage.value.items.map((item) => item.triageEventId),
    ...planHistory.value.items.map((item) => item.remediationEventId),
    ...resolutionHistory.value.items.map((item) => item.resolutionEventId),
  ])
  return { sources, otherRecordIds }
}

// ---- record (§6, POST escalation-events) -----------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

const EMPTY_SHAPE = {
  reasonCode: null,
  targetMemberId: null,
  escalationEventId: null,
  acknowledgementEventId: null,
  followupCode: null,
  sourceEventId: null,
  sourceEventKind: null,
  returnReasonCode: null,
}

async function recordOnTransaction(
  claimId: string,
  exceptionIntakeId: string,
  request: EscalationEventRequest,
  actorUserId: string,
  tx: DbClient,
  attempted?: { event: AttemptedEscalationEvent | null },
): Promise<EscalationEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionEscalation.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const intake = await intakeOf(claimId, exceptionIntakeId, tx)
  if (!intake) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = parentOfIntake(intake)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_ESCALATION_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the actor's own membership, and for an escalation the current, eligible A8.2 assignee holding raise.
  const disposition = await dispositionOf(claimId, parent, tx)
  const membership = await findActorMembership(parent.organizationId, actorUserId, tx)
  const actorPermissions = membership ? await permissionsOf(membership.id, actorUserId, parent.organizationId) : null
  if (request.eventCode === 'ESCALATE_FOR_REVIEW') {
    const isAssignee =
      !!membership &&
      disposition.dispositionCode === 'ASSIGNED' &&
      disposition.assignedMemberId === membership.id &&
      disposition.assigneeCurrentlyEligible === true &&
      holdsAll(actorPermissions, [ASSIGNEE_PERMISSION, RAISE_PERMISSION])
    if (!isAssignee) return refuse('EXCEPTION_ESCALATION_NOT_ASSIGNEE', NOT_ASSIGNEE_MESSAGE)
  } else if (!membership) {
    return refuse(request.eventCode === 'RETURN_TO_OWNER' ? 'EXCEPTION_ESCALATION_NOT_INDEPENDENT' : 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE', NO_MEMBERSHIP_MESSAGE)
  }
  const membershipId = (membership as { id: string }).id

  // 5 — the exception is assigned now; the upstream owners and the A8.7 gate; the stored escalation history.
  if (disposition.dispositionCode !== 'ASSIGNED' || !disposition.assignedMemberId) return refuse('EXCEPTION_ESCALATION_TRANSITION_REFUSED', NOT_ASSIGNED_MESSAGE)
  const currentAssignee = disposition.assignedMemberId
  const upstream = await upstreamOf(claimId, parent, request.eventCode, tx)
  const history = await historyOf(parent, tx)
  if (!history) return refuse('EXCEPTION_ESCALATION_CONFLICT', INCONSISTENT_MESSAGE)

  // 6 — the event's own references, the step, then present eligibility.
  const actor = { recordedByMembershipId: membershipId, recordedByUserId: actorUserId }
  let shape: EscalationEventShape
  let target: { id: string; userId: string } | null = null
  if (request.eventCode === 'ESCALATE_FOR_REVIEW') {
    const member = await findMembershipById(request.targetMemberId, tx)
    if (!member || member.organizationId !== parent.organizationId) return refuse('NOT_FOUND', MEMBER_NOT_FOUND_MESSAGE)
    target = member
    shape = { ...EMPTY_SHAPE, eventCode: request.eventCode, reasonCode: request.reasonCode, targetMemberId: request.targetMemberId, ...actor }
  } else if (request.eventCode === 'ACKNOWLEDGE_ESCALATION') {
    shape = { ...EMPTY_SHAPE, eventCode: request.eventCode, escalationEventId: request.escalationEventId, ...actor }
  } else if (request.eventCode === 'RECORD_FOLLOWUP') {
    const kind = upstream.sources.get(request.sourceEventId)
    if (!kind) {
      const ownIds = new Set(history.records.map((record) => record.id))
      if (upstream.otherRecordIds.has(request.sourceEventId) || ownIds.has(request.sourceEventId)) return refuse('UNSUPPORTED_REFERENCE', UNSUPPORTED_MESSAGE)
      return refuse('NOT_FOUND', SOURCE_NOT_FOUND_MESSAGE)
    }
    shape = { ...EMPTY_SHAPE, eventCode: request.eventCode, acknowledgementEventId: request.acknowledgementEventId, followupCode: request.followupCode, sourceEventId: request.sourceEventId, sourceEventKind: kind, ...actor }
  } else {
    shape = { ...EMPTY_SHAPE, eventCode: request.eventCode, escalationEventId: request.escalationEventId, returnReasonCode: request.returnReasonCode, ...actor }
  }
  const next = applyEscalationEvent(history.derived, shape)
  if (!next.ok) return refuse(CODE_OF_REFUSAL[next.refusal], `${next.detail}; nothing was recorded`)

  if (request.eventCode === 'ESCALATE_FOR_REVIEW') {
    const nominated = target as { id: string; userId: string }
    if (nominated.id === currentAssignee || !holdsAll(await permissionsOf(nominated.id, nominated.userId, parent.organizationId), HANDLER_PERMISSIONS))
      return refuse('EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE', TARGET_NOT_ELIGIBLE_MESSAGE)
  } else if (request.eventCode === 'RETURN_TO_OWNER') {
    if (membershipId === currentAssignee || !holdsAll(actorPermissions, [REVIEW_PERMISSION])) return refuse('EXCEPTION_ESCALATION_NOT_INDEPENDENT', REVIEWER_MESSAGE)
  } else if (membershipId === currentAssignee || !holdsAll(actorPermissions, HANDLER_PERMISSIONS)) {
    return refuse('EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE', HANDLER_NOT_ELIGIBLE_MESSAGE)
  }

  // 7 — one event and one business audit, atomically.
  const sequence = next.derived.lastSequence
  if (attempted) attempted.event = { ...shape, sequence }
  const event = await insertEscalationEvent({ ...parent, ...shape, contractVersion: ESCALATION_CONTRACT_VERSION, sequence }, tx)
  await concurrencyProbe('exceptionEscalation.inserted')
  // Metadata only: ids, contract, sequence, the controlled codes, the nominated member, the escalation,
  // acknowledgement and source pointers, the acting membership and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_escalation.recorded',
      entityType: 'EXCEPTION_ESCALATION_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        escalationEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        reasonCode: event.reasonCode,
        targetMemberId: event.targetMemberId,
        referencedEscalationEventId: event.escalationEventId,
        acknowledgementEventId: event.acknowledgementEventId,
        followupCode: event.followupCode,
        sourceEventId: event.sourceEventId,
        sourceEventKind: event.sourceEventKind,
        returnReasonCode: event.returnReasonCode,
        recordedByMembershipId: event.recordedByMembershipId,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionEscalation.audited')
  return toEventDto(event)
}

// An unknown outcome is reconciled against the exact committed history on a fresh read: the event at the attempted
// sequence either is exactly this request (membership, actor and every controlled field), is another event, or does
// not exist. Nothing is retried and success is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedEscalationEvent | null): Promise<EscalationResult<never>> {
  const conflict = (message: string): EscalationResult<never> => ({ ok: false, code: 'EXCEPTION_ESCALATION_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findEscalationEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's escalation history before requesting again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this event at sequence ${attempted.sequence} (escalation event ${reconciled.escalationEventId}); it was not requested again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this request was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): EscalationResult<EscalationEventRequest> => {
  if (!isEscalationUuid(claimId)) return invalid('invalid claim id')
  if (!isEscalationUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateEscalationEvent(body)
  return event.ok ? { ok: true, value: event.value } : { ok: false, code: event.code, message: event.message }
}

export async function recordEscalationEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<EscalationResult<EscalationEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedEscalationEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof EscalationRefusalError) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_ESCALATION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_ESCALATION_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_ESCALATION_CONFLICT', message: 'concurrent escalation requests for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the escalation event; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The event on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordEscalationEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<EscalationResult<EscalationEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof EscalationRefusalError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§6) --------------------------------------------------------------------------------------

async function readParentAndHistory(
  claimId: string,
  exceptionIntakeId: string,
  tx: DbClient,
): Promise<EscalationResult<{ parent: EscalationParent; records: EscalationEventRecord[]; derived: EscalationDerived }>> {
  if (!isEscalationUuid(claimId)) return invalid('invalid claim id')
  if (!isEscalationUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const intake = await intakeOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!intake) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = parentOfIntake(intake)
  const history = parent.organizationId === claim.organizationId ? await historyOf(parent, tx) : null
  if (!history) return { ok: false, code: 'EXCEPTION_ESCALATION_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, ...history } }
}

// One intake's history on the CALLER's transaction — what later owners consult. Nothing is written.
export async function getEscalationHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<EscalationResult<EscalationHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: { contractVersion: ESCALATION_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() },
  }
}

// One intake's derived escalation disposition on the CALLER's transaction — the reader a future owner consults. It
// opens no transaction of its own and writes nothing. The A8.1–A8.7 records stay their own sources of truth and are not
// copied (the A8.7 state is read from A8.7). A historical event is never recomputed from present permissions.
export async function getEscalationDispositionOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<EscalationResult<EscalationDispositionDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { derived, records, parent } = read.value
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: ESCALATION_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      state: derived.state,
      escalation: derived.escalation,
      acknowledgement: derived.acknowledgement,
      followups: derived.followups,
      returned: derived.returned,
      eventCount: records.length,
      lastSequence: records.length > 0 ? derived.lastSequence : null,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getEscalationHistory(claimId: string, exceptionIntakeId: string): Promise<EscalationResult<EscalationHistoryDto>> {
  if (!isEscalationUuid(claimId) || !isEscalationUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getEscalationHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getEscalationDisposition(claimId: string, exceptionIntakeId: string): Promise<EscalationResult<EscalationDispositionDto>> {
  if (!isEscalationUuid(claimId) || !isEscalationUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getEscalationDispositionOf(claimId, exceptionIntakeId, tx))
}
