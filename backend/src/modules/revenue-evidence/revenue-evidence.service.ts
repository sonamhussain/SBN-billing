import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owner A7.1 consumes, on THIS transaction and unchanged: A6.7 verifies that the frozen bytes still match
// their digests. The A6.8 lifecycle and A6.9 lineage are never read here: no payer truth is derived from them,
// and neither gates nor changes a registration.
import { getFrozenSubmission } from '../claim-submission/claim-submission.service.ts'
import {
  findEvidenceById,
  findEvidenceByIdentity,
  findEvidenceOfSubmission,
  findSubmissionForRevenueEvidence,
  insertRevenueSourceEvidence,
  type RevenueSourceEvidenceRecord,
} from './revenue-evidence.repository.ts'
import {
  REVENUE_SOURCE_CONTRACT_VERSION,
  type RevenueEvidenceErrorCode,
  type RevenueEvidenceResult,
  type RevenueSourceEvidenceDto,
  type RevenueSourceEvidenceListDto,
  type RevenueSourceEvidenceOutcome,
  type RevenueSourceEvidenceRequest,
  type RevenueSourceKind,
} from './revenue-evidence.types.ts'
import { isRevenueEvidenceUuid, validateRevenueSourceEvidenceBody } from './revenue-evidence.validation.ts'

// A7.1 §6 — a registration is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Submission -> Claim -> Encounter -> Patient -> Organization, answered
//    another tenant's submission exactly like a missing one, and checked revenueEvidence.create; the body is
//    strict;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted A6 convention); a busy Claim is
//    waited for outside the transaction and the request starts again on a fresh snapshot;
// 3. under the lock the frozen submission is re-read through its A6.7 owner, which verifies its stored bytes
//    against their digests (a mismatch is a conflict, never repaired);
// 4. an existing registration with the same identity is the idempotent answer (200, the original record);
// 5. exactly one registration and one metadata-only audit are appended atomically; the database guard
//    re-checks time and organization.
// Nothing is paid, posted, adjudicated, sent or rewritten.

class RevenueEvidenceRefusal extends Error {
  readonly code: RevenueEvidenceErrorCode
  constructor(code: RevenueEvidenceErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: RevenueEvidenceErrorCode, message: string): never {
  throw new RevenueEvidenceRefusal(code, message)
}

const invalid = (message: string): RevenueEvidenceResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_REGISTRATION_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished.
const MAX_LOCK_WAITS = 5

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer (Prisma: P2034); a deadlock is retried the same way, on a fresh transaction.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE identity refuses a colliding writer; the retry re-reads and answers the replay.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = ['revenue_source_evidence_time', 'revenue_source_evidence_coherence', 'revenue_source_evidence is append-only', 'revenue_source_evidence_kind_chk', 'revenue_source_evidence_reference_chk']

// A lost connection or transaction leaves the outcome unknown: never re-inserted, the caller re-reads.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toEvidenceDto(record: RevenueSourceEvidenceRecord): RevenueSourceEvidenceDto {
  return {
    revenueSourceEvidenceId: record.id,
    claimSubmissionId: record.claimSubmissionId,
    sourceKind: record.sourceKind as RevenueSourceKind,
    sourceReference: record.sourceReference,
    sourceVersion: record.sourceVersion,
    sourceDigestSha256: record.sourceDigestSha256,
    receivedAt: record.receivedAt.toISOString(),
    recordedByUserId: record.recordedByUserId,
  }
}

// A6.7 verifies the frozen bytes against their digests; a mismatch is an integrity conflict, never repaired.
async function readFreezeThroughOwner(claimId: string, submissionId: string, tx: DbClient) {
  try {
    return await getFrozenSubmission(claimId, submissionId, tx)
  } catch (error) {
    if (error instanceof Error && /do not match their stored digests/.test(error.message))
      return refuse('REVENUE_EVIDENCE_CONFLICT', 'the frozen submission no longer matches its stored digests; nothing was registered')
    throw error
  }
}

// ---- register (§6, POST revenue-source-evidence) -------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function registerOnTransaction(owner: { claimId: string }, submissionId: string, request: RevenueSourceEvidenceRequest, actorUserId: string, tx: DbClient): Promise<RevenueSourceEvidenceOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', owner.claimId))) return refuse('NOT_FOUND', 'claim submission not found')
  await concurrencyProbe('revenueEvidence.claim_locked')
  const submission = await findSubmissionForRevenueEvidence(submissionId, tx)
  if (!submission || submission.claimId !== owner.claimId) return refuse('NOT_FOUND', 'claim submission not found')

  // 3 — the exact frozen submission, verified by its owner on this transaction.
  const frozen = await readFreezeThroughOwner(submission.claimId, submissionId, tx)
  if (!frozen) return refuse('NOT_FOUND', 'claim submission not found')

  // 4 — the same identity already registered is the idempotent answer: the original record, unchanged.
  const identity = { claimSubmissionId: submissionId, sourceKind: request.sourceKind, sourceReference: request.sourceReference, sourceVersion: REVENUE_SOURCE_CONTRACT_VERSION }
  const existing = await findEvidenceByIdentity(identity, tx)
  if (existing) {
    // Under the identity only server-owned values can differ; a stored row that disagrees with them is an
    // integrity conflict, never overwritten.
    if (existing.organizationId !== submission.organizationId || existing.sourceDigestSha256 !== null)
      return refuse('REVENUE_EVIDENCE_CONFLICT', 'a registration with this identity disagrees with its frozen submission; nothing was registered')
    return { replayed: true, evidence: toEvidenceDto(existing) }
  }

  // 5 — one registration and one business audit, atomically.
  const evidence = await insertRevenueSourceEvidence({ ...identity, organizationId: submission.organizationId, recordedByUserId: actorUserId }, tx)
  await concurrencyProbe('revenueEvidence.inserted')
  // §5 — metadata only: ids, kind, opaque reference, contract and time. No PHI, bytes, digest, amount or text.
  await recordAuditEvent(
    {
      organizationId: submission.organizationId,
      actorUserId,
      actionCode: 'revenue_source_evidence.registered',
      entityType: 'REVENUE_SOURCE_EVIDENCE',
      entityId: evidence.id,
      beforeState: null,
      afterState: {
        revenueSourceEvidenceId: evidence.id,
        claimSubmissionId: submissionId,
        sourceKind: evidence.sourceKind,
        sourceReference: evidence.sourceReference,
        sourceVersion: evidence.sourceVersion,
        receivedAt: evidence.receivedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('revenueEvidence.audited')
  return { replayed: false, evidence: toEvidenceDto(evidence) }
}

export async function registerRevenueSourceEvidence(submissionId: string, body: unknown, actorUserId: string): Promise<RevenueEvidenceResult<RevenueSourceEvidenceOutcome>> {
  if (!isRevenueEvidenceUuid(submissionId)) return invalid('invalid claim submission id')
  const validated = validateRevenueSourceEvidenceBody(body)
  if (!validated.ok) return invalid(validated.message)
  const id = submissionId.toLowerCase()
  // The freeze's Claim never changes (the freeze row is immutable), so it is read before the lock and verified
  // again under it.
  const owner = await findSubmissionForRevenueEvidence(id, prisma)
  if (!owner) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }

  let lockWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => registerOnTransaction(owner, id, validated.value, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof RevenueEvidenceRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        lockWaits += 1
        if (lockWaits > MAX_LOCK_WAITS) return { ok: false, code: 'REVENUE_EVIDENCE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was registered' }
        await waitForClaimLock(owner.claimId)
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_REGISTRATION_ATTEMPTS) continue
        return { ok: false, code: 'REVENUE_EVIDENCE_CONFLICT', message: 'concurrent registrations for this submission kept conflicting; nothing was registered' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'REVENUE_EVIDENCE_CONFLICT', message: 'the database refused the registration as inconsistent with its frozen submission; nothing was registered' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'REVENUE_EVIDENCE_CONFLICT', message: 'the outcome could not be established; read the submission\'s source evidence before registering again' }
      throw error
    }
  }
}

// ---- reads (§5) ----------------------------------------------------------------------------------------

// A frozen submission's registrations on the CALLER's transaction — the evidence later A7 owners consult.
// Nothing is written.
export async function getRevenueSourceEvidenceOf(submissionId: string, tx: DbClient): Promise<RevenueEvidenceResult<RevenueSourceEvidenceListDto>> {
  if (!isRevenueEvidenceUuid(submissionId)) return invalid('invalid claim submission id')
  const id = submissionId.toLowerCase()
  if (!(await findSubmissionForRevenueEvidence(id, tx))) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }
  return { ok: true, value: { items: (await findEvidenceOfSubmission(id, tx)).map(toEvidenceDto) } }
}

// The public history read, from one READ ONLY snapshot.
export async function listRevenueSourceEvidence(submissionId: string): Promise<RevenueEvidenceResult<RevenueSourceEvidenceListDto>> {
  if (!isRevenueEvidenceUuid(submissionId)) return invalid('invalid claim submission id')
  return withReadSnapshot(undefined, (tx) => getRevenueSourceEvidenceOf(submissionId, tx))
}

export async function getRevenueSourceEvidence(evidenceId: string): Promise<RevenueEvidenceResult<RevenueSourceEvidenceDto>> {
  if (!isRevenueEvidenceUuid(evidenceId)) return invalid('invalid revenue source evidence id')
  const record = await findEvidenceById(evidenceId.toLowerCase())
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'revenue source evidence not found' }
  return { ok: true, value: toEvidenceDto(record) }
}
