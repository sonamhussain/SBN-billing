import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A7.3 consumes, on THIS transaction and unchanged: A7.2 answers which classifications a source has
// (classification, outcome, reason and fingerprint as stored); A7.1 answers which registrations a frozen submission
// has. The A7.2 classifier and fingerprint are never re-run, and no A6 lifecycle or lineage is read.
import { getClassificationsOf } from '../evidence-classification/evidence-classification.service.ts'
import { getRevenueSourceEvidenceOf } from '../revenue-evidence/revenue-evidence.service.ts'
import { deriveReadiness, recordedReadinessAgrees } from './evidence-gate.reducer.ts'
import {
  findClassificationForGate,
  findReadinessById,
  findReadinessByIdentity,
  findReadinessOfClassification,
  insertReadiness,
  type ClassificationForGate,
  type ReadinessRecord,
} from './evidence-gate.repository.ts'
import {
  READINESS_CONTRACT_VERSION,
  type ReadinessCode,
  type ReadinessDto,
  type ReadinessErrorCode,
  type ReadinessListDto,
  type ReadinessOutcome,
  type ReadinessReasonCode,
  type ReadinessResult,
} from './evidence-gate.types.ts'
import { isReadinessUuid, validateReadinessBody } from './evidence-gate.validation.ts'

// A7.3 §7 — a readiness result is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Classification -> Organization, answered another tenant's classification exactly
//    like a missing one, and checked adjudicationReadiness.create; the body is empty;
// 2. the Claim (classification -> source -> frozen submission -> Claim) row lock is the FIRST statement, without
//    waiting (the accepted A6 convention); a busy Claim is waited for outside the transaction within a time budget;
// 3. under the lock the classification is re-read with its source and submission; source, classification and
//    organization must link exactly, A7.2 must confirm the stored classification and A7.1 the registration;
// 4. the one pure reducer derives the readiness from the stored classification; anything uncontrolled is a
//    provenance conflict and nothing is recorded;
// 5. an existing result with the same identity is the idempotent answer when it agrees exactly, and a conflict
//    (never a rewrite) when it does not;
// 6. exactly one result and one metadata-only audit are appended atomically; the database guard re-derives the
//    readiness and re-checks time, linkage, organization and the copied fingerprint.
// Nothing is adjudicated, paid, posted, sent or rewritten.

class ReadinessRefusal extends Error {
  readonly code: ReadinessErrorCode
  constructor(code: ReadinessErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ReadinessErrorCode, message: string): never {
  throw new ReadinessRefusal(code, message)
}

const invalid = (message: string): ReadinessResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const notFound = (): ReadinessResult<never> => ({ ok: false, code: 'NOT_FOUND', message: 'revenue evidence classification not found' })

const MAX_READINESS_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits
// are bounded by time, not by a small count, so identical requests released together cannot starve each other;
// a short random pause after each wait breaks that lock-step (timing only, never an outcome).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer (Prisma: P2034); a deadlock is retried the same way, on a fresh transaction.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE identity refuses a colliding writer; the retry re-reads and answers the replay.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = [
  'evidence_gate_result_time',
  'evidence_gate_result_linkage',
  'evidence_gate_result_coherence',
  'evidence_gate_result_conflict',
  'evidence_gate_result_derivation',
  'evidence_gate_result_fingerprint',
  'evidence_gate_results is append-only',
]

// A lost connection or transaction leaves the outcome unknown: never re-inserted, the caller re-reads.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toReadinessDto(record: ReadinessRecord): ReadinessDto {
  return {
    readinessId: record.id,
    classificationId: record.classificationId,
    sourceEvidenceId: record.sourceEvidenceId,
    contractVersion: record.contractVersion,
    readinessCode: record.readinessCode as ReadinessCode,
    reasonCode: record.reasonCode as ReadinessReasonCode,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- record (§7, POST adjudication-readiness) ------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

// §5 — source <-> classification <-> organization, the frozen submission's owner, and the two owners' own reads.
async function confirmLinkage(located: ClassificationForGate, tx: DbClient) {
  const linked =
    located.sourceId !== null && located.sourceId === located.sourceEvidenceId && located.claimSubmissionId !== null &&
    located.organizationId === located.sourceOrganizationId && located.organizationId === located.submissionOrganizationId
  if (!linked) return refuse('ADJUDICATION_READINESS_PROVENANCE_CONFLICT', 'the classification, its source and their organization do not link exactly; nothing was recorded')
  const classifications = await getClassificationsOf(located.sourceEvidenceId, tx)
  const stored = classifications.ok ? classifications.value.items.find((item) => item.classificationId === located.classificationId) : undefined
  const confirmed =
    stored !== undefined &&
    stored.contractVersion === located.contractVersion &&
    stored.classificationCode === located.classificationCode &&
    stored.normalizationOutcome === located.normalizationOutcome &&
    stored.reasonCode === located.reasonCode &&
    stored.sourceFingerprintSha256 === located.sourceFingerprintSha256
  if (!confirmed) return refuse('ADJUDICATION_READINESS_PROVENANCE_CONFLICT', 'the classification could not be confirmed by its owner; nothing was recorded')
  const registrations = await getRevenueSourceEvidenceOf(located.claimSubmissionId as string, tx)
  if (!registrations.ok || !registrations.value.items.some((item) => item.revenueSourceEvidenceId === located.sourceEvidenceId))
    return refuse('ADJUDICATION_READINESS_PROVENANCE_CONFLICT', 'the source could not be confirmed by its owner; nothing was recorded')
}

async function recordOnTransaction(owner: { claimId: string }, classificationId: string, actorUserId: string, tx: DbClient): Promise<ReadinessOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', owner.claimId))) return refuse('NOT_FOUND', 'revenue evidence classification not found')
  await concurrencyProbe('evidenceGate.claim_locked')

  // 3 — the classification, re-read under the lock, and its exact links confirmed by their owners.
  const located = await findClassificationForGate(classificationId, tx)
  if (!located || located.claimId !== owner.claimId) return refuse('NOT_FOUND', 'revenue evidence classification not found')
  await confirmLinkage(located, tx)

  // 4 — the one pure reducer, from the stored classification.
  const derived = deriveReadiness(located)
  if (!derived.ok) return refuse('ADJUDICATION_READINESS_PROVENANCE_CONFLICT', 'the classification is not a controlled A7-EVIDENCE-CLASS-1 result; nothing was recorded')
  const expected = { ...derived.value, classificationFingerprintSha256: located.sourceFingerprintSha256, sourceEvidenceId: located.sourceEvidenceId, organizationId: located.organizationId }

  // 5 — the same identity already recorded: the original result when it agrees exactly, never a rewrite.
  const existing = await findReadinessByIdentity(classificationId, READINESS_CONTRACT_VERSION, tx)
  if (existing) {
    if (!recordedReadinessAgrees(existing, expected))
      return refuse('ADJUDICATION_READINESS_PROVENANCE_CONFLICT', 'the recorded readiness of this classification disagrees with its derivation; it was not changed')
    return { replayed: true, readiness: toReadinessDto(existing) }
  }

  // 6 — one result and one business audit, atomically.
  const readiness = await insertReadiness({ ...expected, classificationId, contractVersion: READINESS_CONTRACT_VERSION, recordedByUserId: actorUserId }, tx)
  await concurrencyProbe('evidenceGate.inserted')
  // §6 — metadata only: ids, the controlled codes, contract and time. No fingerprint, PHI, reference or amount.
  await recordAuditEvent(
    {
      organizationId: readiness.organizationId,
      actorUserId,
      actionCode: 'adjudication_readiness.recorded',
      entityType: 'ADJUDICATION_READINESS',
      entityId: readiness.id,
      beforeState: null,
      afterState: {
        readinessId: readiness.id,
        classificationId,
        sourceEvidenceId: readiness.sourceEvidenceId,
        contractVersion: readiness.contractVersion,
        readinessCode: readiness.readinessCode,
        reasonCode: readiness.reasonCode,
        recordedAt: readiness.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('evidenceGate.audited')
  return { replayed: false, readiness: toReadinessDto(readiness) }
}

export async function recordAdjudicationReadiness(classificationId: string, body: unknown, actorUserId: string): Promise<ReadinessResult<ReadinessOutcome>> {
  if (!isReadinessUuid(classificationId)) return invalid('invalid revenue evidence classification id')
  const validated = validateReadinessBody(body)
  if (!validated.ok) return invalid(validated.message)
  const id = classificationId.toLowerCase()
  // The classification's source, frozen submission and Claim never change (every row is immutable), so the Claim
  // is read before the lock for routing only and verified again under it.
  const located = await findClassificationForGate(id, prisma)
  if (!located) return notFound()
  if (!located.claimId) return { ok: false, code: 'ADJUDICATION_READINESS_PROVENANCE_CONFLICT', message: 'the classification does not resolve to a frozen submission; nothing was recorded' }
  const owner = { claimId: located.claimId }

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(owner, id, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof ReadinessRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'ADJUDICATION_READINESS_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(owner.claimId)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_READINESS_ATTEMPTS) continue
        return { ok: false, code: 'ADJUDICATION_READINESS_CONFLICT', message: 'concurrent readiness requests for this classification kept conflicting; nothing was recorded' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'ADJUDICATION_READINESS_PROVENANCE_CONFLICT', message: 'the database refused the readiness as inconsistent with its classification; nothing was recorded' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'ADJUDICATION_READINESS_CONFLICT', message: 'the outcome could not be established; read the classification\'s readiness history before requesting again' }
      throw error
    }
  }
}

// ---- reads (§6) ----------------------------------------------------------------------------------------

// A classification's readiness results on the CALLER's transaction — what later A7 owners consult. Nothing is
// written.
export async function getReadinessOf(classificationId: string, tx: DbClient): Promise<ReadinessResult<ReadinessListDto>> {
  if (!isReadinessUuid(classificationId)) return invalid('invalid revenue evidence classification id')
  const id = classificationId.toLowerCase()
  if (!(await findClassificationForGate(id, tx))) return notFound()
  return { ok: true, value: { items: (await findReadinessOfClassification(id, tx)).map(toReadinessDto) } }
}

// The public history read, from one READ ONLY snapshot.
export async function listAdjudicationReadiness(classificationId: string): Promise<ReadinessResult<ReadinessListDto>> {
  if (!isReadinessUuid(classificationId)) return invalid('invalid revenue evidence classification id')
  return withReadSnapshot(undefined, (tx) => getReadinessOf(classificationId, tx))
}

export async function getAdjudicationReadiness(readinessId: string): Promise<ReadinessResult<ReadinessDto>> {
  if (!isReadinessUuid(readinessId)) return invalid('invalid adjudication evidence readiness id')
  const record = await findReadinessById(readinessId.toLowerCase())
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'adjudication evidence readiness not found' }
  return { ok: true, value: toReadinessDto(record) }
}
