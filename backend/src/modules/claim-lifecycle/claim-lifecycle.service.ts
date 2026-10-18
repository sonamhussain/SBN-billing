import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { nextLifecycleState, reduceLifecycle } from './claim-lifecycle.reducer.ts'
import { findLifecycleEvents, findSubmissionForLifecycle, insertLifecycleEvent, transactionTime, type LifecycleEventRecord } from './claim-lifecycle.repository.ts'
import {
  LIFECYCLE_CONTRACT_VERSION,
  type ClaimLifecycleErrorCode,
  type ClaimLifecycleResult,
  type LifecycleEventCode,
  type LifecycleEventDto,
  type LifecycleEventListDto,
  type LifecycleReasonCode,
  type LifecycleStateDto,
  type RecordedLifecycleEventDto,
} from './claim-lifecycle.types.ts'
import { isClaimLifecycleUuid, validateLifecycleEventBody } from './claim-lifecycle.validation.ts'

// A6.8 §6 — a lifecycle event is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Submission -> Claim -> Encounter -> Patient -> Organization (the A6.7
//    ownership path), answered another tenant's submission exactly like a missing one, and checked the
//    actor's claimLifecycle.record permission; the request body is strict;
// 2. the Claim row lock is the FIRST statement, without waiting (the same lock every A6.2–A6.7 writer
//    takes); a busy Claim is waited for outside the transaction and the decision starts again on a fresh
//    snapshot, a bounded number of times;
// 3. under the lock, the exact frozen submission and its ordered events are read and the one pure reducer
//    derives the current disposition (a corrupt history is a conflict, never a guess);
// 4. the requested edge is checked against the A6-LIFECYCLE-1 table; exactly one event and one
//    metadata-only audit are appended atomically, and the database guard re-checks time, sequence and edge.
// A duplicate or unlisted edge is a 409, never a replayed 200. Nothing is sent, queued or given a payer
// state, and the frozen bytes, digests, evidence package and approval are never read or changed.

class LifecycleRefusal extends Error {
  readonly code: ClaimLifecycleErrorCode
  constructor(code: ClaimLifecycleErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClaimLifecycleErrorCode, message: string): never {
  throw new LifecycleRefusal(code, message)
}

const invalid = (message: string): ClaimLifecycleResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_EVENT_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the decision starts again once the writer has finished.
const MAX_LOCK_WAITS = 5

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer (Prisma: P2034); a deadlock is retried the same way. Each retry is a fresh transaction
// that re-reads the history, so a retry never appends on a stale view.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The unique (submission, sequence) key refuses a colliding writer; the retry re-reads the history.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = ['claim_lifecycle_time', 'claim_lifecycle_sequence', 'claim_lifecycle_transition', 'claim_freeze_lifecycle_events is append-only']

// A lost connection or transaction during the write leaves its outcome unknown. It is never retried by
// appending again: the caller is told to read the history first.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTOs --------------------------------------------------------------------------------------------

function toEventDto(record: LifecycleEventRecord): LifecycleEventDto {
  return {
    id: record.id,
    submissionId: record.claimFreezeId,
    sequence: record.sequence,
    eventCode: record.eventCode as LifecycleEventCode,
    reasonCode: record.reasonCode as LifecycleReasonCode | null,
    actorUserId: record.actorUserId,
    lifecycleContractVersion: record.lifecycleContractVersion,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  }
}

// ---- derived disposition (§7) ------------------------------------------------------------------------

// The derived disposition of one frozen submission on the CALLER's transaction: its ordered events through
// the one pure reducer, evaluated at the database's own time. A history the reducer cannot trust is a
// conflict. Reads write nothing. Later owners (A9 adapters) call this inside their own transaction.
export async function getCurrentLifecycle(submissionId: string, tx: DbClient): Promise<ClaimLifecycleResult<LifecycleStateDto>> {
  if (!isClaimLifecycleUuid(submissionId)) return invalid('invalid claim submission id')
  const id = submissionId.toLowerCase()
  if (!(await findSubmissionForLifecycle(id, tx))) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }
  const events = await findLifecycleEvents(id, tx)
  const reduced = reduceLifecycle(events)
  if (!reduced.ok) return { ok: false, code: 'CLAIM_LIFECYCLE_CONFLICT', message: `the lifecycle history cannot be trusted (${reduced.reason})` }
  return {
    ok: true,
    value: {
      submissionId: id,
      lifecycleContractVersion: LIFECYCLE_CONTRACT_VERSION,
      state: reduced.state,
      lastEventId: events.at(-1)?.id ?? null,
      lastSequence: reduced.lastSequence,
      evaluatedAt: (await transactionTime(tx)).toISOString(),
    },
  }
}

// ---- record an event (§6, POST lifecycle-events) --------------------------------------------------------

// Waits, outside any event transaction, until the current holder of the Claim lock has finished. The lock
// is released at once; it only orders this decision after that writer.
async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

export async function recordLifecycleEvent(submissionId: string, body: unknown, actorUserId: string): Promise<ClaimLifecycleResult<RecordedLifecycleEventDto>> {
  if (!isClaimLifecycleUuid(submissionId)) return invalid('invalid claim submission id')
  const validated = validateLifecycleEventBody(body)
  if (!validated.ok) return invalid(validated.message)
  const request = validated.value
  const id = submissionId.toLowerCase()
  // The freeze's Claim never changes (the freeze row is immutable), so it can be read before the lock and
  // is verified again under it.
  const owner = await findSubmissionForLifecycle(id, prisma)
  if (!owner) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }

  let lockWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction(
        async (tx) => {
          if (!(await lockRowForUpdateNowait(tx, 'claims', owner.claimId))) return refuse('NOT_FOUND', 'claim submission not found')
          await concurrencyProbe('claimLifecycle.claim_locked')
          const submission = await findSubmissionForLifecycle(id, tx)
          if (!submission || submission.claimId !== owner.claimId) return refuse('NOT_FOUND', 'claim submission not found')
          const events = await findLifecycleEvents(id, tx)
          const reduced = reduceLifecycle(events)
          if (!reduced.ok) return refuse('CLAIM_LIFECYCLE_CONFLICT', `the lifecycle history cannot be trusted (${reduced.reason}); nothing was recorded`)
          const next = nextLifecycleState(reduced.state, request.eventCode)
          if (next === null) return refuse('CLAIM_LIFECYCLE_TRANSITION_NOT_ALLOWED', `${request.eventCode} is not allowed from ${reduced.state}; nothing was recorded`)

          const event = await insertLifecycleEvent(
            {
              submissionId: id,
              sequence: reduced.lastSequence + 1,
              eventCode: request.eventCode,
              reasonCode: request.reasonCode,
              actorUserId,
              lifecycleContractVersion: LIFECYCLE_CONTRACT_VERSION,
            },
            tx,
          )
          await concurrencyProbe('claimLifecycle.inserted')
          // §7 — metadata only: ids, codes, sequence, contract and time. No PHI, bytes, digest, amount,
          // payer detail or request body.
          await recordAuditEvent(
            {
              organizationId: submission.organizationId,
              actorUserId,
              actionCode: 'claim_lifecycle.event_recorded',
              entityType: 'CLAIM_LIFECYCLE_EVENT',
              entityId: event.id,
              beforeState: null,
              afterState: {
                eventId: event.id,
                submissionId: id,
                claimId: submission.claimId,
                eventCode: event.eventCode,
                reasonCode: event.reasonCode,
                sequence: event.sequence,
                lifecycleContractVersion: event.lifecycleContractVersion,
                occurredAt: event.occurredAt.toISOString(),
              },
            },
            tx,
          )
          await concurrencyProbe('claimLifecycle.audited')
          return {
            event: toEventDto(event),
            lifecycle: {
              submissionId: id,
              lifecycleContractVersion: LIFECYCLE_CONTRACT_VERSION,
              state: next,
              lastEventId: event.id,
              lastSequence: event.sequence,
              evaluatedAt: event.occurredAt.toISOString(),
            },
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000 },
      )
      return { ok: true, value }
    } catch (error) {
      if (error instanceof LifecycleRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        lockWaits += 1
        if (lockWaits > MAX_LOCK_WAITS) return { ok: false, code: 'CLAIM_LIFECYCLE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(owner.claimId)
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_EVENT_ATTEMPTS) continue
        return { ok: false, code: 'CLAIM_LIFECYCLE_CONFLICT', message: 'concurrent lifecycle decisions on this submission kept conflicting; nothing was recorded' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'CLAIM_LIFECYCLE_CONFLICT', message: 'the database refused the event as inconsistent with this submission\'s history; nothing was recorded' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'CLAIM_LIFECYCLE_CONFLICT', message: 'the outcome could not be established; read the lifecycle history before deciding again' }
      throw error
    }
  }
}

// ---- reads (§5, §7) -----------------------------------------------------------------------------------

export async function listLifecycleEvents(submissionId: string): Promise<ClaimLifecycleResult<LifecycleEventListDto>> {
  if (!isClaimLifecycleUuid(submissionId)) return invalid('invalid claim submission id')
  const id = submissionId.toLowerCase()
  // One READ ONLY snapshot: the whole history in sequence order, from one committed state.
  const records = await withReadSnapshot(undefined, async (tx) => ((await findSubmissionForLifecycle(id, tx)) ? findLifecycleEvents(id, tx) : null))
  if (!records) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }
  return { ok: true, value: { items: records.map(toEventDto) } }
}

export async function getLifecycleState(submissionId: string): Promise<ClaimLifecycleResult<LifecycleStateDto>> {
  if (!isClaimLifecycleUuid(submissionId)) return invalid('invalid claim submission id')
  // Read-only: the history and its evaluation time come from one snapshot; nothing is written.
  return withReadSnapshot(undefined, (tx) => getCurrentLifecycle(submissionId, tx))
}
