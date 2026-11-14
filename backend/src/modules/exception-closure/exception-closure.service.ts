import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.9 consumes, unchanged: the A6.7 Claim ownership path and the Claim's frozen submissions, the A8.1
// intakes of a Claim, the A8.2 triage disposition and history, the A8.3 investigation history, the A8.5 remediation
// disposition and history, the A8.6 work disposition and history, the A8.7 resolution disposition and history, the A8.8
// escalation disposition and history of an intake on the caller's transaction, the CRG coding status of a frozen
// submission as recorded, the A1 effective permissions of a member, and the database's own evaluation instant.
import { findClaimForFreeze, findFreezesOfClaim } from '../claim-submission/claim-submission.repository.ts'
import { getSubmissionCodingProvenanceOf } from '../coding-validation/coding-validation.service.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import type { ExceptionIntakeDto } from '../exception-intake/exception-intake.types.ts'
import { getTriageDispositionOf, getTriageHistoryOf } from '../exception-triage/exception-triage.service.ts'
import { getInvestigationHistoryOf } from '../exception-investigation/exception-investigation.service.ts'
import { getRemediationDispositionOf, getRemediationHistoryOf } from '../exception-remediation/exception-remediation.service.ts'
import { getWorkDispositionOf, getWorkHistoryOf } from '../exception-remediation-work/exception-remediation-work.service.ts'
import { getResolutionDispositionOf, getResolutionHistoryOf } from '../exception-resolution/exception-resolution.service.ts'
import { getEscalationDispositionOf, getEscalationHistoryOf } from '../exception-escalation/exception-escalation.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyNewClosure, buildReconstruction, deriveClosure, eligibilityOf, reconcileAttempt } from './exception-closure.reducer.ts'
import { findActorMembership, findClosureEventsOfIntake, insertClosureEvent, type ClosureEventRecord } from './exception-closure.repository.ts'
import {
  type AttemptedClosureEvent,
  BASIS_OWNER_CONTRACT,
  type BasisReferenceKind,
  CLOSURE_CONTRACT_VERSION,
  type ClosureDerived,
  type ClosureErrorCode,
  type ClosureEventCode,
  type ClosureEventDto,
  type ClosureEventRequest,
  type ClosureEventShape,
  type ClosureHistoryDto,
  type ClosureParent,
  type ClosureReasonCode,
  type ClosureReconstructionDto,
  type ClosureRefusal,
  type ClosureResult,
  CONFIRM_PERMISSION,
  type OwnerRecord,
  type SubmissionEntry,
} from './exception-closure.types.ts'
import { isClosureUuid, validateClosureEvent } from './exception-closure.validation.ts'

// A8.9 §6 — a closure is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked the seven upstream read permissions (A8.1, A8.2, A8.3, A8.5, A8.6, A8.7, A8.8) and
//    exceptionClosure.confirm; the body is the event and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A8.1–A8.8 convention, so an A8.2
//    reassignment, an A8.7 decision, an A8.8 event and an A8.9 closure on one Claim are serialized); a busy Claim is
//    waited for outside the transaction within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the confirmer is judged first: its own membership of the organization holding exceptionClosure.confirm now;
// 5. the exception must be ASSIGNED now (D3); the A8.3, A8.5, A8.6, A8.7 and A8.8 owners are read on the same client (an
//    inconsistent owner history fails closed); the stored closure history is derived by the pure reducer;
// 6. the named A8.7 decision must be an A8.7 event of this intake and, for a return basis, the basis an A8.8 event of
//    this intake (otherwise the identical 404); the pure gate then judges eligibility (§3, CL-01, CL-02), the exact basis
//    and the confirmer's independence of the A8.7 requester and decider (D1);
// 7. exactly one event and one metadata-only audit are appended atomically; the database guard re-checks time,
//    coherence, the acting membership and permission, the assignment, the confirmed decision, independence, the A8.8
//    position, the exact basis, the terminal state and the sequence.
// There is no idempotency key: a repeat is refused (409, D4), and an unknown commit outcome is never retried blindly: it
// is reconciled against the committed history and answered 409 with what that history holds. CLOSED_INTERNAL is an
// internal process position only: nothing is reopened, adjudicated, corrected, paid or sent, and nothing upstream
// changes.

class ClosureRefusalError extends Error {
  readonly code: ClosureErrorCode
  constructor(code: ClosureErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClosureErrorCode, message: string): never {
  throw new ClosureRefusalError(code, message)
}

const invalid = (message: string): ClosureResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const DECISION_NOT_FOUND_MESSAGE = 'resolution decision not found for this exception'
const BASIS_NOT_FOUND_MESSAGE = 'basis record not found for this exception'
const NO_MEMBERSHIP_MESSAGE = 'an exception is closed only by a member of the owning organization holding the closure confirm permission now; nothing was recorded'
const NOT_ASSIGNED_MESSAGE = 'the exception is not assigned now; an exception is closed only while it is assigned; nothing was recorded'
const INCONSISTENT_MESSAGE = "the exception's stored closure history is inconsistent; nothing was derived or recorded"
const TRIAGE_UNREADABLE_MESSAGE = "the exception's triage history is inconsistent, so its assignment cannot be established; nothing was recorded"
const UPSTREAM_UNREADABLE_MESSAGE = "the exception's investigation, remediation, work, resolution or escalation history is inconsistent; nothing was recorded"
const INTEGRITY_MESSAGE = "the exception's owner records do not anchor its recorded closure exactly; no partial reconstruction is answered"

const MAX_CLOSURE_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence) and the one closure per intake refuse a competing writer; the retry re-reads the history
// and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): ClosureErrorCode | null =>
  /exception_closure_eligibility/.test(message)
    ? 'EXCEPTION_CLOSURE_NOT_ELIGIBLE'
    : /exception_closure_independence/.test(message)
      ? 'EXCEPTION_CLOSURE_NOT_INDEPENDENT'
      : /exception_closure_(sequence|transition)/.test(message)
        ? 'EXCEPTION_CLOSURE_TRANSITION_REFUSED'
        : /exception_closure_(time|coherence|member)|exception_closure_events is append-only/.test(message)
          ? 'EXCEPTION_CLOSURE_CONFLICT'
          : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// D7 — each reducer refusal answered as its own kind.
const CODE_OF_REFUSAL: Record<ClosureRefusal, ClosureErrorCode> = {
  SHAPE: 'EXCEPTION_CLOSURE_CONFLICT',
  NOT_ELIGIBLE: 'EXCEPTION_CLOSURE_NOT_ELIGIBLE',
  NOT_INDEPENDENT: 'EXCEPTION_CLOSURE_NOT_INDEPENDENT',
  TRANSITION_REFUSED: 'EXCEPTION_CLOSURE_TRANSITION_REFUSED',
}

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: ClosureEventRecord): ClosureEventDto {
  return {
    closureEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as ClosureEventCode,
    resolutionDecisionEventId: record.resolutionDecisionEventId,
    closureReasonCode: record.closureReasonCode as ClosureReasonCode,
    basisReferenceKind: record.basisReferenceKind as BasisReferenceKind,
    basisReferenceId: record.basisReferenceId,
    basisOwnerContractVersion: record.basisOwnerContractVersion,
    recordedByMembershipId: record.recordedByMembershipId,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- the parent, the owners and the history ------------------------------------------------------

async function intakeOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ExceptionIntakeDto | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  return intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId) ?? null
}

const parentOfIntake = (intake: ExceptionIntakeDto): ClosureParent => ({ exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId })

async function historyOf(parent: ClosureParent, tx: DbClient): Promise<{ records: ClosureEventRecord[]; derived: ClosureDerived } | null> {
  const records = await findClosureEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveClosure(parent, records)
  return derived.ok ? { records, derived: derived.value } : null
}

// Every upstream owner of this intake on tx, through its accepted readers (never its tables). null when any owner
// cannot answer for itself.
async function ownersOf(claimId: string, parent: ClosureParent, tx: DbClient) {
  const intakeId = parent.exceptionIntakeId
  const triage = await getTriageHistoryOf(claimId, intakeId, tx)
  const investigation = await getInvestigationHistoryOf(claimId, intakeId, tx)
  const plan = await getRemediationDispositionOf(claimId, intakeId, tx)
  const planHistory = await getRemediationHistoryOf(claimId, intakeId, tx)
  const work = await getWorkDispositionOf(claimId, intakeId, tx)
  const workHistory = await getWorkHistoryOf(claimId, intakeId, tx)
  const resolution = await getResolutionDispositionOf(claimId, intakeId, tx)
  const resolutionHistory = await getResolutionHistoryOf(claimId, intakeId, tx)
  const escalation = await getEscalationDispositionOf(claimId, intakeId, tx)
  const escalationHistory = await getEscalationHistoryOf(claimId, intakeId, tx)
  if (!triage.ok || !investigation.ok || !plan.ok || !planHistory.ok || !work.ok || !workHistory.ok || !resolution.ok || !resolutionHistory.ok || !escalation.ok || !escalationHistory.ok) return null
  return {
    triage: triage.value, investigation: investigation.value, plan: plan.value, planHistory: planHistory.value, work: work.value, workHistory: workHistory.value, resolution: resolution.value,
    resolutionHistory: resolutionHistory.value, escalation: escalation.value, escalationHistory: escalationHistory.value,
  }
}
type Owners = NonNullable<Awaited<ReturnType<typeof ownersOf>>>

const resolutionFactsOf = (owners: Owners) => ({
  state: owners.resolution.state,
  request: owners.resolution.request
    ? { resolutionEventId: owners.resolution.request.resolutionEventId, requestedByMembershipId: owners.resolution.request.requestedByMembershipId, requestedByUserId: owners.resolution.request.requestedByUserId }
    : null,
  decision: owners.resolution.decision
    ? {
        resolutionEventId: owners.resolution.decision.resolutionEventId,
        decisionCode: owners.resolution.decision.decisionCode,
        decidedByMembershipId: owners.resolution.decision.decidedByMembershipId,
        decidedByUserId: owners.resolution.decision.decidedByUserId,
      }
    : null,
})
const escalationFactsOf = (owners: Owners) => ({ state: owners.escalation.state, returned: owners.escalation.returned ? { returnEventId: owners.escalation.returned.returnEventId, returnReasonCode: owners.escalation.returned.returnReasonCode } : null })

// ---- record (§6, POST closure-events) -----------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function recordOnTransaction(
  claimId: string,
  exceptionIntakeId: string,
  request: ClosureEventRequest,
  actorUserId: string,
  tx: DbClient,
  attempted?: { event: AttemptedClosureEvent | null },
): Promise<ClosureEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionClosure.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const intake = await intakeOf(claimId, exceptionIntakeId, tx)
  if (!intake) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = parentOfIntake(intake)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_CLOSURE_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the confirmer: its own membership holding exceptionClosure.confirm now.
  const membership = await findActorMembership(parent.organizationId, actorUserId, tx)
  const access = membership ? await getEffectivePermissions(actorUserId, parent.organizationId) : null
  if (!membership || !access || access.membershipId !== membership.id || !access.permissions.includes(CONFIRM_PERMISSION)) return refuse('EXCEPTION_CLOSURE_NOT_INDEPENDENT', NO_MEMBERSHIP_MESSAGE)

  // 5 — assigned now, the owners on this client, the stored closure history.
  const disposition = await getTriageDispositionOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok) return disposition.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_CLOSURE_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
  if (disposition.value.dispositionCode !== 'ASSIGNED') return refuse('EXCEPTION_CLOSURE_NOT_ELIGIBLE', NOT_ASSIGNED_MESSAGE)
  const owners = (await ownersOf(claimId, parent, tx)) ?? refuse('EXCEPTION_CLOSURE_CONFLICT', UPSTREAM_UNREADABLE_MESSAGE)
  const history = await historyOf(parent, tx)
  if (!history) return refuse('EXCEPTION_CLOSURE_CONFLICT', INCONSISTENT_MESSAGE)

  // 6 — the named records through their owners, then the gate.
  if (!owners.resolutionHistory.items.some((item) => item.resolutionEventId === request.resolutionDecisionEventId)) return refuse('NOT_FOUND', DECISION_NOT_FOUND_MESSAGE)
  if (request.basisReferenceKind === 'ESCALATION_RETURN' && !owners.escalationHistory.items.some((item) => item.escalationEventId === request.basisReferenceId))
    return refuse('NOT_FOUND', BASIS_NOT_FOUND_MESSAGE)
  const shape: ClosureEventShape = {
    eventCode: request.eventCode,
    resolutionDecisionEventId: request.resolutionDecisionEventId,
    closureReasonCode: request.closureReasonCode,
    basisReferenceKind: request.basisReferenceKind,
    basisReferenceId: request.basisReferenceId,
    basisOwnerContractVersion: BASIS_OWNER_CONTRACT[request.basisReferenceKind],
    recordedByMembershipId: membership.id,
    recordedByUserId: actorUserId,
  }
  const next = applyNewClosure(history.derived, eligibilityOf(resolutionFactsOf(owners), escalationFactsOf(owners)), shape)
  if (!next.ok) return refuse(CODE_OF_REFUSAL[next.refusal], `${next.detail}; nothing was recorded`)

  // 7 — one event and one business audit, atomically.
  const sequence = next.derived.lastSequence
  if (attempted) attempted.event = { ...shape, sequence }
  const event = await insertClosureEvent(
    { ...parent, ...shape, resolutionDecisionEventId: request.resolutionDecisionEventId, basisReferenceKind: request.basisReferenceKind, basisReferenceId: request.basisReferenceId, basisOwnerContractVersion: shape.basisOwnerContractVersion as string, closureReasonCode: request.closureReasonCode, contractVersion: CLOSURE_CONTRACT_VERSION, sequence },
    tx,
  )
  await concurrencyProbe('exceptionClosure.inserted')
  // Metadata only: ids, contract, sequence, the controlled codes, the decision and basis pointers, the acting membership
  // and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_closure.recorded',
      entityType: 'EXCEPTION_CLOSURE_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        closureEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        resolutionDecisionEventId: event.resolutionDecisionEventId,
        closureReasonCode: event.closureReasonCode,
        basisReferenceKind: event.basisReferenceKind,
        basisReferenceId: event.basisReferenceId,
        basisOwnerContractVersion: event.basisOwnerContractVersion,
        recordedByMembershipId: event.recordedByMembershipId,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionClosure.audited')
  return toEventDto(event)
}

// An unknown outcome is reconciled against the exact committed history on a fresh read. Nothing is retried and success
// is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedClosureEvent | null): Promise<ClosureResult<never>> {
  const conflict = (message: string): ClosureResult<never> => ({ ok: false, code: 'EXCEPTION_CLOSURE_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findClosureEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's closure history before confirming again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this closure at sequence ${attempted.sequence} (closure event ${reconciled.closureEventId}); it was not confirmed again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this closure was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): ClosureResult<ClosureEventRequest> => {
  if (!isClosureUuid(claimId)) return invalid('invalid claim id')
  if (!isClosureUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateClosureEvent(body)
  return event.ok ? { ok: true, value: event.value } : { ok: false, code: event.code, message: event.message }
}

export async function recordClosureEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<ClosureResult<ClosureEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedClosureEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof ClosureRefusalError) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_CLOSURE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_CLOSURE_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_CLOSURE_CONFLICT', message: 'concurrent closures for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the closure; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The closure on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordClosureEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<ClosureResult<ClosureEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof ClosureRefusalError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§5, §6) --------------------------------------------------------------------------------------

async function readParentAndHistory(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ClosureResult<{ parent: ClosureParent; records: ClosureEventRecord[]; derived: ClosureDerived }>> {
  if (!isClosureUuid(claimId)) return invalid('invalid claim id')
  if (!isClosureUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const intake = await intakeOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!intake) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = parentOfIntake(intake)
  const history = parent.organizationId === claim.organizationId ? await historyOf(parent, tx) : null
  if (!history) return { ok: false, code: 'EXCEPTION_CLOSURE_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, ...history } }
}

// One intake's closure history on the CALLER's transaction — what later owners consult. Nothing is written.
export async function getClosureHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ClosureResult<ClosureHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return { ok: true, value: { contractVersion: CLOSURE_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() } }
}

// §5 — the read-only historical reconstruction of the recorded closure on the CALLER's transaction: the canonical
// owner chain, each record as its owner reports it, anchored to the recorded closure, then the Claim's frozen submissions
// with their CRG coding status exactly as the CRG owner reports it (a legacy status is never upgraded; present rights,
// editions or memberships never rewrite it). A derived DTO, never persisted; any absent, ambiguous or foreign record is
// INTEGRITY_CONFLICT — never a partial reconstruction.
export async function getClosureReconstructionOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ClosureResult<ClosureReconstructionDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { parent, records, derived } = read.value
  const claim = claimId.toLowerCase()
  const owners = await ownersOf(claim, parent, tx)
  const intake = await intakeOf(claim, parent.exceptionIntakeId, tx)
  if (!owners || !intake) return { ok: false, code: 'INTEGRITY_CONFLICT', message: INTEGRITY_MESSAGE }
  const of = (recordId: string, item: { contractVersion: string; sequence: number; eventCode: string; exceptionIntakeId: string; organizationId: string; claimId: string }): OwnerRecord => ({
    recordId, contractVersion: item.contractVersion, sequence: item.sequence, eventCode: item.eventCode, exceptionIntakeId: item.exceptionIntakeId, organizationId: item.organizationId, claimId: item.claimId,
  })
  const built = buildReconstruction({
    parent,
    intake: { recordId: intake.exceptionIntakeId, contractVersion: intake.contractVersion, sequence: null, eventCode: null, exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId },
    triage: owners.triage.items.map((item) => of(item.triageEventId, item)),
    investigation: owners.investigation.items.map((item) => of(item.investigationEventId, item)),
    remediation: owners.planHistory.items.map((item) => of(item.remediationEventId, item)),
    work: owners.workHistory.items.map((item) => of(item.workEventId, item)),
    resolution: owners.resolutionHistory.items.map((item) => of(item.resolutionEventId, item)),
    escalation: owners.escalationHistory.items.map((item) => of(item.escalationEventId, item)),
    closure: records.map((record) => of(record.id, record)),
    recorded: derived.closure,
    anchors: {
      requestVerificationEventId: owners.resolution.request?.verificationEventId ?? null,
      workVerificationEventId: owners.work.verification?.workEventId ?? null,
      workApprovedProposalEventId: owners.work.approvedProposalEventId,
      planApprovedProposalEventId: owners.plan.approvedProposalEventId,
    },
  })
  if (!built.ok) return { ok: false, code: 'INTEGRITY_CONFLICT', message: INTEGRITY_MESSAGE }
  const submissions: SubmissionEntry[] = []
  if (derived.closure) {
    for (const freeze of await findFreezesOfClaim(claim, tx)) {
      const coding = await getSubmissionCodingProvenanceOf(freeze.id, tx)
      if (!coding.ok) return { ok: false, code: 'INTEGRITY_CONFLICT', message: INTEGRITY_MESSAGE }
      submissions.push({
        submissionId: freeze.id,
        submissionContractVersion: coding.value.submissionContractVersion,
        codingVerificationStatus: coding.value.verificationStatus,
        codingContractVersion: coding.value.contractVersion,
      })
    }
  }
  const evaluatedAt = await readTransactionTimestamp(tx)
  const recorded = records.find((record) => record.id === derived.closure?.closureEventId)
  return {
    ok: true,
    value: {
      contractVersion: CLOSURE_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      state: derived.state,
      recordedClosure: recorded ? toEventDto(recorded) : null,
      chain: built.chain,
      submissions,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getClosureHistory(claimId: string, exceptionIntakeId: string): Promise<ClosureResult<ClosureHistoryDto>> {
  if (!isClosureUuid(claimId) || !isClosureUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getClosureHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getClosureReconstruction(claimId: string, exceptionIntakeId: string): Promise<ClosureResult<ClosureReconstructionDto>> {
  if (!isClosureUuid(claimId) || !isClosureUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getClosureReconstructionOf(claimId, exceptionIntakeId, tx))
}
