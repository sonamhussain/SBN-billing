import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { getEffectivePermissions } from '../../shared/authorization/authorization.service.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.3 consumes, unchanged: the A6.7 Claim ownership path, the A8.1 intakes of a Claim and the A8.2 triage
// disposition and history of an intake on the caller's transaction, the A7.5 assessment and its case's Claim (the
// path A8.1 accepted), the A1 effective permissions of a member, and the database's own evaluation instant.
import { findClaimForFreeze } from '../claim-submission/claim-submission.repository.ts'
import { getExceptionIntakesOf } from '../exception-intake/exception-intake.service.ts'
import type { ExceptionIntakeDto } from '../exception-intake/exception-intake.types.ts'
import { getTriageDispositionOf, getTriageHistoryOf } from '../exception-triage/exception-triage.service.ts'
import { findAssessmentById, findCaseForPrerequisite } from '../case-prerequisite/case-prerequisite.repository.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { applyInvestigationEvent, deriveInvestigation, reconcileAttempt } from './exception-investigation.reducer.ts'
import { findActorMembership, findInvestigationEventsOfIntake, insertInvestigationEvent, type InvestigationEventRecord } from './exception-investigation.repository.ts'
import {
  type AttemptedInvestigationEvent,
  INVESTIGATION_CONTRACT_VERSION,
  INVESTIGATOR_PERMISSION,
  type EvidenceKind,
  type FindingCode,
  type InvestigationErrorCode,
  type InvestigationEventCode,
  type InvestigationEventDto,
  type InvestigationEventRequest,
  type InvestigationEventShape,
  type InvestigationHistoryDto,
  type InvestigationParent,
  type InvestigationResult,
  type InvestigationState,
  type InvestigationSummaryDto,
} from './exception-investigation.types.ts'
import { isInvestigationUuid, validateInvestigationEvent } from './exception-investigation.validation.ts'

// A8.3 §6 — an investigation event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked exceptionIntake.read, exceptionTriage.read and exceptionInvestigation.record; the body is one event
//    and its own controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A8.1/A8.2 convention, so an A8.2
//    reassignment or return and an A8.3 write on one Claim are serialized); a busy Claim is waited for outside the
//    transaction within a time budget;
// 3. under the lock the Claim's organization is re-read and the parent intake is found among the Claim's A8.1 intakes
//    (another Claim's or tenant's intake is the same 404 as a missing one);
// 4. the A8.2 disposition is re-read: the exception must be ASSIGNED, to exactly the acting member's membership, which
//    must be eligible now and hold exceptionInvestigation.record — otherwise 409, before anything else is judged (no
//    Admin override);
// 5. the intake's stored investigation history is derived by the pure reducer; an inconsistent history refuses the
//    write (never repaired);
// 6. a link's record is verified through its own owner for this exact intake, Claim and organization (another
//    tenant's or Claim's record is the same 404 as a missing one), and the event must be a legal next step (409);
// 7. exactly one event, numbered one more than the history, and one metadata-only audit are appended atomically; the
//    database guard re-checks time, coherence, the acting membership, the current assignment, eligibility, the
//    sequence, the evidence reference and the finding's link.
// There is no idempotency key: an exact repeat is refused by the history rules, and an unknown commit outcome is never
// retried blindly: it is reconciled against the committed history and answered 409 with what that history holds.
// Nothing is assigned, resolved, closed, escalated, paid or changed in the intake, its triage history or any source.

class InvestigationRefusal extends Error {
  readonly code: InvestigationErrorCode
  constructor(code: InvestigationErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: InvestigationErrorCode, message: string): never {
  throw new InvestigationRefusal(code, message)
}

const invalid = (message: string): InvestigationResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or exception intake not found'
const EVIDENCE_NOT_FOUND_MESSAGE = 'evidence record not found for this exception'
const NOT_ASSIGNEE_MESSAGE = 'only the current, eligible assignee of this exception records investigation events; nothing was recorded'
const INCONSISTENT_MESSAGE = "the exception's stored investigation history is inconsistent; nothing was derived or recorded"
const TRIAGE_UNREADABLE_MESSAGE = "the exception's triage history is inconsistent, so its assignment cannot be established; nothing was recorded"

const MAX_INVESTIGATION_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count; a short random pause after each wait breaks lock-step (timing only).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// A serialization failure or deadlock is retried on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE (intake, sequence) and (intake, kind, record) refuse a competing writer; the retry re-reads the history
// and judges again.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check, each refusal answered as its own kind.
const guardRefusal = (message: string): InvestigationErrorCode | null =>
  /exception_investigation_assignee/.test(message)
    ? 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE'
    : /exception_investigation_(sequence|finding|repeat)/.test(message)
      ? 'EXCEPTION_INVESTIGATION_TRANSITION_REFUSED'
      : /exception_investigation_(time|coherence|member|evidence)|exception_investigation_events is append-only/.test(message)
        ? 'EXCEPTION_INVESTIGATION_CONFLICT'
        : null

// A lost connection or transaction leaves the outcome unknown: never appended again blindly.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toEventDto(record: InvestigationEventRecord): InvestigationEventDto {
  return {
    investigationEventId: record.id,
    contractVersion: record.contractVersion,
    exceptionIntakeId: record.exceptionIntakeId,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sequence: record.sequence,
    eventCode: record.eventCode as InvestigationEventCode,
    evidenceKind: record.evidenceKind as EvidenceKind | null,
    evidenceRecordId: record.evidenceRecordId,
    evidenceContractVersion: record.evidenceContractVersion,
    evidenceBasisCode: record.evidenceBasisCode,
    linkedEvidenceEventId: record.linkedEvidenceEventId,
    findingCode: record.findingCode as FindingCode | null,
    recordedByMembershipId: record.recordedByMembershipId,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- the parent, the assignment and the history -------------------------------------------------------------

// The parent intake among the Claim's A8.1 intakes on tx, or null. Another Claim's or tenant's intake is not there.
async function intakeOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<ExceptionIntakeDto | null> {
  const intakes = await getExceptionIntakesOf(claimId, tx)
  if (!intakes.ok) return null
  return intakes.value.items.find((item) => item.exceptionIntakeId === exceptionIntakeId) ?? null
}

const parentOfIntake = (intake: ExceptionIntakeDto): InvestigationParent => ({ exceptionIntakeId: intake.exceptionIntakeId, organizationId: intake.organizationId, claimId: intake.claimId })

async function historyOf(parent: InvestigationParent, tx: DbClient): Promise<{ records: InvestigationEventRecord[]; state: InvestigationState } | null> {
  const records = await findInvestigationEventsOfIntake(parent.exceptionIntakeId, tx)
  const derived = deriveInvestigation(parent, records)
  return derived.ok ? { records, state: derived.value } : null
}

// §3/§6 — the acting member's membership, if the A8.2 disposition holds the exception ASSIGNED to exactly it, that
// assignee is eligible now under the A8.2 policy, and it holds exceptionInvestigation.record now. Otherwise null.
async function actingAssignee(claimId: string, parent: InvestigationParent, actorUserId: string, tx: DbClient): Promise<string | null> {
  const disposition = await getTriageDispositionOf(claimId, parent.exceptionIntakeId, tx)
  if (!disposition.ok) return disposition.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_INVESTIGATION_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
  const membership = await findActorMembership(parent.organizationId, actorUserId, tx)
  if (!membership) return null
  const { dispositionCode, assignedMemberId, assigneeCurrentlyEligible } = disposition.value
  if (dispositionCode !== 'ASSIGNED' || assignedMemberId !== membership.id || assigneeCurrentlyEligible !== true) return null
  const access = await getEffectivePermissions(actorUserId, parent.organizationId)
  return access && access.membershipId === membership.id && access.permissions.includes(INVESTIGATOR_PERMISSION) ? membership.id : null
}

// §4 — the record a link names, verified through its own owner for exactly this intake, Claim and organization, and
// the basis code it carries (the intake's own, for INTAKE_BASIS). A missing record and another intake's, Claim's or
// tenant's are the same 404; a record under another contract than the one stated is refused (409).
async function verifiedEvidence(request: Extract<InvestigationEventRequest, { eventCode: 'LINK_EVIDENCE_REFERENCE' }>, intake: ExceptionIntakeDto, tx: DbClient): Promise<{ evidenceBasisCode: string | null }> {
  const underContract = (contractVersion: string) => {
    if (contractVersion !== request.evidenceContractVersion) refuse('EXCEPTION_INVESTIGATION_CONFLICT', 'the evidence record is not recorded under the stated contract; nothing was recorded')
  }
  switch (request.evidenceKind) {
    case 'INTAKE_BASIS':
      if (intake.basisRecordId !== request.evidenceRecordId) return refuse('NOT_FOUND', EVIDENCE_NOT_FOUND_MESSAGE)
      underContract(intake.contractVersion)
      return { evidenceBasisCode: intake.basisCode }
    case 'TRIAGE_EVENT': {
      const history = await getTriageHistoryOf(intake.claimId, intake.exceptionIntakeId, tx)
      if (!history.ok) return history.code === 'NOT_FOUND' ? refuse('NOT_FOUND', NOT_FOUND_MESSAGE) : refuse('EXCEPTION_INVESTIGATION_CONFLICT', TRIAGE_UNREADABLE_MESSAGE)
      const event = history.value.items.find((item) => item.triageEventId === request.evidenceRecordId)
      if (!event || event.exceptionIntakeId !== intake.exceptionIntakeId || event.organizationId !== intake.organizationId) return refuse('NOT_FOUND', EVIDENCE_NOT_FOUND_MESSAGE)
      underContract(event.contractVersion)
      return { evidenceBasisCode: null }
    }
    case 'A7_CASE_ASSESSMENT': {
      const assessment = await findAssessmentById(request.evidenceRecordId, tx)
      if (!assessment || assessment.organizationId !== intake.organizationId) return refuse('NOT_FOUND', EVIDENCE_NOT_FOUND_MESSAGE)
      const located = await findCaseForPrerequisite(assessment.evidenceCaseId, tx)
      if (!located || located.claimId !== intake.claimId || located.organizationId !== intake.organizationId) return refuse('NOT_FOUND', EVIDENCE_NOT_FOUND_MESSAGE)
      underContract(assessment.contractVersion)
      return { evidenceBasisCode: null }
    }
  }
}

// ---- record (§6, POST investigation-events) ---------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function recordOnTransaction(claimId: string, exceptionIntakeId: string, request: InvestigationEventRequest, actorUserId: string, tx: DbClient, attempted?: { event: AttemptedInvestigationEvent | null }): Promise<InvestigationEventDto> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionInvestigation.claim_locked')

  // 3 — the Claim's organization under the lock, then the parent intake through its A8.1 owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const intake = await intakeOf(claimId, exceptionIntakeId, tx)
  if (!intake) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const parent = parentOfIntake(intake)
  if (parent.organizationId !== claim.organizationId) return refuse('EXCEPTION_INVESTIGATION_CONFLICT', INCONSISTENT_MESSAGE)

  // 4 — the current A8.2 assignment, before anything else is judged.
  const membershipId = await actingAssignee(claimId, parent, actorUserId, tx)
  if (!membershipId) return refuse('EXCEPTION_INVESTIGATION_NOT_ASSIGNEE', NOT_ASSIGNEE_MESSAGE)

  // 5 — the stored investigation history.
  const history = await historyOf(parent, tx)
  if (!history) return refuse('EXCEPTION_INVESTIGATION_CONFLICT', INCONSISTENT_MESSAGE)

  // 6 — the evidence through its owner, then the next step.
  const shape: InvestigationEventShape =
    request.eventCode === 'LINK_EVIDENCE_REFERENCE'
      ? { eventCode: request.eventCode, evidenceKind: request.evidenceKind, evidenceRecordId: request.evidenceRecordId, evidenceContractVersion: request.evidenceContractVersion, ...(await verifiedEvidence(request, intake, tx)), linkedEvidenceEventId: null, findingCode: null }
      : { eventCode: request.eventCode, evidenceKind: null, evidenceRecordId: null, evidenceContractVersion: null, evidenceBasisCode: null, linkedEvidenceEventId: request.linkedEvidenceEventId, findingCode: request.findingCode }
  const next = applyInvestigationEvent(history.state, shape)
  if (!next.ok) return refuse('EXCEPTION_INVESTIGATION_TRANSITION_REFUSED', `${next.detail}; nothing was recorded`)

  // 7 — one event and one business audit, atomically.
  const sequence = next.state.lastSequence
  if (attempted) attempted.event = { ...shape, sequence, recordedByMembershipId: membershipId, recordedByUserId: actorUserId }
  const event = await insertInvestigationEvent({ ...parent, ...shape, contractVersion: INVESTIGATION_CONTRACT_VERSION, sequence, recordedByMembershipId: membershipId, recordedByUserId: actorUserId }, tx)
  await concurrencyProbe('exceptionInvestigation.inserted')
  // Metadata only: ids, contract, sequence, the controlled codes, the evidence pointer, the acting membership and time.
  await recordAuditEvent(
    {
      organizationId: event.organizationId,
      actorUserId,
      actionCode: 'exception_investigation.recorded',
      entityType: 'EXCEPTION_INVESTIGATION_EVENT',
      entityId: event.id,
      beforeState: null,
      afterState: {
        investigationEventId: event.id,
        exceptionIntakeId: event.exceptionIntakeId,
        claimId: event.claimId,
        contractVersion: event.contractVersion,
        sequence: event.sequence,
        eventCode: event.eventCode,
        evidenceKind: event.evidenceKind,
        evidenceRecordId: event.evidenceRecordId,
        evidenceContractVersion: event.evidenceContractVersion,
        evidenceBasisCode: event.evidenceBasisCode,
        linkedEvidenceEventId: event.linkedEvidenceEventId,
        findingCode: event.findingCode,
        recordedByMembershipId: event.recordedByMembershipId,
        recordedAt: event.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionInvestigation.audited')
  return toEventDto(event)
}

// An unknown outcome is reconciled against the exact committed history on a fresh read: the event at the attempted
// sequence either is exactly this request (membership, actor and every controlled field), is another event, or does
// not exist. Nothing is retried and success is never reported (no idempotency key); the answer is always 409.
async function reconcileUnknownOutcome(exceptionIntakeId: string, attempted: AttemptedInvestigationEvent | null): Promise<InvestigationResult<never>> {
  const conflict = (message: string): InvestigationResult<never> => ({ ok: false, code: 'EXCEPTION_INVESTIGATION_CONFLICT', message })
  if (!attempted) return conflict('the request failed before an event was written; nothing was recorded')
  const records = await withReadSnapshot(undefined, (tx) => findInvestigationEventsOfIntake(exceptionIntakeId, tx)).catch(() => null)
  if (!records) return conflict("the outcome could not be established; read the exception's investigation history before requesting again")
  const reconciled = reconcileAttempt(records, attempted)
  return reconciled.outcome === 'RECORDED'
    ? conflict(`the committed history holds exactly this event at sequence ${attempted.sequence} (investigation event ${reconciled.investigationEventId}); it was not requested again`)
    : reconciled.outcome === 'OTHER_EVENT'
      ? conflict(`the committed history holds a different event at sequence ${attempted.sequence}; this request was not recorded`)
      : conflict(`the committed history holds no event at sequence ${attempted.sequence}; nothing was recorded`)
}

const validated = (claimId: string, exceptionIntakeId: string, body: unknown): InvestigationResult<InvestigationEventRequest> => {
  if (!isInvestigationUuid(claimId)) return invalid('invalid claim id')
  if (!isInvestigationUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const event = validateInvestigationEvent(body)
  return event.ok ? { ok: true, value: event.value } : invalid(event.message)
}

export async function recordInvestigationEvent(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string): Promise<InvestigationResult<InvestigationEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  const claim = claimId.toLowerCase()
  const intake = exceptionIntakeId.toLowerCase()

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    const attempted: { event: AttemptedInvestigationEvent | null } = { event: null }
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(claim, intake, request.value, actorUserId, tx, attempted), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof InvestigationRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_INVESTIGATION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(claim)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_INVESTIGATION_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_INVESTIGATION_CONFLICT', message: 'concurrent investigation requests for this claim kept conflicting; nothing was recorded' }
      }
      const guarded = error instanceof Error ? guardRefusal(error.message) : null
      if (guarded) return { ok: false, code: guarded, message: 'the database refused the investigation event; nothing was recorded' }
      if (isUnknownOutcome(error)) return reconcileUnknownOutcome(intake, attempted.event)
      throw error
    }
  }
}

// The event on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordInvestigationEventOn(claimId: string, exceptionIntakeId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<InvestigationResult<InvestigationEventDto>> {
  const request = validated(claimId, exceptionIntakeId, body)
  if (!request.ok) return request
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), request.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof InvestigationRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reads (§6) --------------------------------------------------------------------------------------

async function readParentAndHistory(
  claimId: string,
  exceptionIntakeId: string,
  tx: DbClient,
): Promise<InvestigationResult<{ parent: InvestigationParent; records: InvestigationEventRecord[]; state: InvestigationState }>> {
  if (!isInvestigationUuid(claimId)) return invalid('invalid claim id')
  if (!isInvestigationUuid(exceptionIntakeId)) return invalid('invalid exception intake id')
  const claim = await findClaimForFreeze(claimId.toLowerCase(), tx)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const intake = await intakeOf(claimId.toLowerCase(), exceptionIntakeId.toLowerCase(), tx)
  if (!intake) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE }
  const parent = parentOfIntake(intake)
  const history = parent.organizationId === claim.organizationId ? await historyOf(parent, tx) : null
  if (!history) return { ok: false, code: 'EXCEPTION_INVESTIGATION_CONFLICT', message: INCONSISTENT_MESSAGE }
  return { ok: true, value: { parent, ...history } }
}

// One intake's history on the CALLER's transaction — what later A8 owners consult. Nothing is written.
export async function getInvestigationHistoryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<InvestigationResult<InvestigationHistoryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const evaluatedAt = await readTransactionTimestamp(tx)
  return { ok: true, value: { contractVersion: INVESTIGATION_CONTRACT_VERSION, exceptionIntakeId: read.value.parent.exceptionIntakeId, items: read.value.records.map(toEventDto), evaluatedAt: evaluatedAt.toISOString() } }
}

// One intake's derived investigation on the CALLER's transaction. Nothing is written. The A8.1 intake and the A8.2
// disposition stay their own sources of truth and are not copied here.
export async function getInvestigationSummaryOf(claimId: string, exceptionIntakeId: string, tx: DbClient): Promise<InvestigationResult<InvestigationSummaryDto>> {
  const read = await readParentAndHistory(claimId, exceptionIntakeId, tx)
  if (!read.ok) return read
  const { state, records, parent } = read.value
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: INVESTIGATION_CONTRACT_VERSION,
      exceptionIntakeId: parent.exceptionIntakeId,
      investigationCode: state.investigationCode,
      evidenceLinks: state.links,
      findings: state.findings,
      latestFinding: state.findings[state.findings.length - 1] ?? null,
      eventCount: records.length,
      lastSequence: records.length > 0 ? state.lastSequence : null,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public reads, each from one READ ONLY snapshot.
export async function getInvestigationHistory(claimId: string, exceptionIntakeId: string): Promise<InvestigationResult<InvestigationHistoryDto>> {
  if (!isInvestigationUuid(claimId) || !isInvestigationUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getInvestigationHistoryOf(claimId, exceptionIntakeId, tx))
}

export async function getInvestigationSummary(claimId: string, exceptionIntakeId: string): Promise<InvestigationResult<InvestigationSummaryDto>> {
  if (!isInvestigationUuid(claimId) || !isInvestigationUuid(exceptionIntakeId)) return invalid('invalid claim or exception intake id')
  return withReadSnapshot(undefined, (tx) => getInvestigationSummaryOf(claimId, exceptionIntakeId, tx))
}
