import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owner A7.2 consumes, on THIS transaction and unchanged: A7.1 answers which registrations exist for a
// frozen submission. The A6.8 lifecycle and A6.9 lineage are never read: no payer truth is derived from them.
import { getRevenueSourceEvidenceOf } from '../revenue-evidence/revenue-evidence.service.ts'
import { classifySource, recordedClassificationAgrees, sourceFingerprintSha256 } from './evidence-classification.classifier.ts'
import {
  findClassificationById,
  findClassificationByIdentity,
  findClassificationsOfSource,
  findSourceForClassification,
  insertClassification,
  type EvidenceClassificationRecord,
} from './evidence-classification.repository.ts'
import {
  CLASSIFICATION_CONTRACT_VERSION,
  type ClassificationCode,
  type ClassificationReasonCode,
  type EvidenceClassificationDto,
  type EvidenceClassificationErrorCode,
  type EvidenceClassificationListDto,
  type EvidenceClassificationOutcome,
  type EvidenceClassificationResult,
  type NormalizationOutcome,
} from './evidence-classification.types.ts'
import { isEvidenceClassificationUuid, validateClassificationBody } from './evidence-classification.validation.ts'

// A7.2 §7 — a classification is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Source -> Organization, answered another tenant's source exactly like a
//    missing one, and checked evidenceClassification.create; the body is empty;
// 2. the source's Claim (source -> frozen submission -> Claim) row lock is the FIRST statement, without waiting
//    (the accepted A6 convention); a busy Claim is waited for outside the transaction within a time budget;
// 3. under the lock the source is re-read: A7.1 confirms the registration exists for its frozen submission, and
//    its own facts are read at database precision;
// 4. the one pure classifier derives the classification; a claim of external verification is refused; the
//    source fingerprint is computed from the same facts;
// 5. an existing classification with the same identity is the idempotent answer when it agrees exactly, and a
//    conflict (never a rewrite) when it does not;
// 6. exactly one classification and one metadata-only audit are appended atomically; the database guard
//    re-derives the classification and the fingerprint and re-checks time and organization.
// Nothing is paid, posted, adjudicated, sent or rewritten.

class ClassificationRefusal extends Error {
  readonly code: EvidenceClassificationErrorCode
  constructor(code: EvidenceClassificationErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: EvidenceClassificationErrorCode, message: string): never {
  throw new ClassificationRefusal(code, message)
}

const invalid = (message: string): EvidenceClassificationResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_CLASSIFICATION_ATTEMPTS = 3
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
  'source_evidence_classification_time',
  'source_evidence_classification_coherence',
  'source_evidence_classification_derivation',
  'source_evidence_classification_fingerprint',
  'source_evidence_classifications is append-only',
  'source_evidence_classifications_verified_disabled_chk',
]

// A lost connection or transaction leaves the outcome unknown: never re-inserted, the caller re-reads.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toClassificationDto(record: EvidenceClassificationRecord): EvidenceClassificationDto {
  return {
    classificationId: record.id,
    sourceEvidenceId: record.sourceEvidenceId,
    contractVersion: record.contractVersion,
    classificationCode: record.classificationCode as ClassificationCode,
    normalizationOutcome: record.normalizationOutcome as NormalizationOutcome,
    reasonCode: record.reasonCode as ClassificationReasonCode,
    sourceFingerprintSha256: record.sourceFingerprintSha256,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- classify (§7, POST classifications) ---------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function classifyOnTransaction(owner: { claimId: string }, sourceEvidenceId: string, actorUserId: string, tx: DbClient): Promise<EvidenceClassificationOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', owner.claimId))) return refuse('NOT_FOUND', 'revenue source evidence not found')
  await concurrencyProbe('evidenceClassification.claim_locked')

  // 3 — the source, re-read under the lock: its owner confirms the registration, then its own facts.
  const source = await findSourceForClassification(sourceEvidenceId, tx)
  if (!source || source.claimId !== owner.claimId) return refuse('NOT_FOUND', 'revenue source evidence not found')
  const registered = await getRevenueSourceEvidenceOf(source.facts.claimSubmissionId as string, tx)
  const ownerRecord = registered.ok ? registered.value.items.find((item) => item.revenueSourceEvidenceId === sourceEvidenceId) : undefined
  if (!ownerRecord) return refuse('NOT_FOUND', 'revenue source evidence not found')
  if (ownerRecord.sourceKind !== source.facts.sourceKind || ownerRecord.sourceReference !== source.facts.sourceReference || ownerRecord.sourceVersion !== source.facts.sourceVersion)
    return refuse('EVIDENCE_CLASSIFICATION_CONFLICT', 'the source record could not be read consistently; nothing was classified')

  // 4 — the one pure classifier and the source fingerprint, from the same facts.
  const classified = classifySource(source.facts)
  if (!classified.ok) return refuse('EVIDENCE_CLASSIFICATION_NOT_ALLOWED', 'external verification without an authenticated source proof is never classified; nothing was recorded')
  let fingerprint: string
  try {
    fingerprint = sourceFingerprintSha256(source.facts)
  } catch {
    return refuse('EVIDENCE_CLASSIFICATION_CONFLICT', 'the source record has no canonical fingerprint; nothing was classified')
  }

  // 5 — the same identity already classified: the original record when it agrees exactly, never a rewrite.
  const existing = await findClassificationByIdentity(sourceEvidenceId, CLASSIFICATION_CONTRACT_VERSION, tx)
  if (existing) {
    const derived = { ...classified.value, sourceFingerprintSha256: fingerprint, organizationId: source.facts.organizationId as string }
    if (!recordedClassificationAgrees(existing, derived))
      return refuse('EVIDENCE_CLASSIFICATION_CONFLICT', 'the recorded classification of this source disagrees with its re-derivation; it was not changed')
    return { replayed: true, classification: toClassificationDto(existing) }
  }

  // 6 — one classification and one business audit, atomically.
  const classification = await insertClassification(
    {
      organizationId: source.facts.organizationId as string,
      sourceEvidenceId,
      contractVersion: CLASSIFICATION_CONTRACT_VERSION,
      ...classified.value,
      sourceFingerprintSha256: fingerprint,
      recordedByUserId: actorUserId,
    },
    tx,
  )
  await concurrencyProbe('evidenceClassification.inserted')
  // §6 — metadata only: ids, the controlled codes, contract and time. No PHI, reference, digest or amount.
  await recordAuditEvent(
    {
      organizationId: classification.organizationId,
      actorUserId,
      actionCode: 'evidence_classification.recorded',
      entityType: 'EVIDENCE_CLASSIFICATION',
      entityId: classification.id,
      beforeState: null,
      afterState: {
        classificationId: classification.id,
        sourceEvidenceId,
        contractVersion: classification.contractVersion,
        classificationCode: classification.classificationCode,
        normalizationOutcome: classification.normalizationOutcome,
        reasonCode: classification.reasonCode,
        recordedAt: classification.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('evidenceClassification.audited')
  return { replayed: false, classification: toClassificationDto(classification) }
}

export async function classifySourceEvidence(sourceEvidenceId: string, body: unknown, actorUserId: string): Promise<EvidenceClassificationResult<EvidenceClassificationOutcome>> {
  if (!isEvidenceClassificationUuid(sourceEvidenceId)) return invalid('invalid revenue source evidence id')
  const validated = validateClassificationBody(body)
  if (!validated.ok) return invalid(validated.message)
  const id = sourceEvidenceId.toLowerCase()
  // The source's frozen submission and Claim never change (both rows are immutable), so the Claim is read
  // before the lock and verified again under it.
  const located = await findSourceForClassification(id, prisma)
  if (!located || !located.claimId) return { ok: false, code: 'NOT_FOUND', message: 'revenue source evidence not found' }
  const owner = { claimId: located.claimId }

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => classifyOnTransaction(owner, id, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof ClassificationRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EVIDENCE_CLASSIFICATION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was classified' }
        await waitForClaimLock(owner.claimId)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_CLASSIFICATION_ATTEMPTS) continue
        return { ok: false, code: 'EVIDENCE_CLASSIFICATION_CONFLICT', message: 'concurrent classifications of this source kept conflicting; nothing was classified' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'EVIDENCE_CLASSIFICATION_CONFLICT', message: 'the database refused the classification as inconsistent with its source; nothing was classified' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'EVIDENCE_CLASSIFICATION_CONFLICT', message: 'the outcome could not be established; read the source\'s classifications before classifying again' }
      throw error
    }
  }
}

// ---- reads (§6) ----------------------------------------------------------------------------------------

// A source record's classifications on the CALLER's transaction — what later A7 owners consult. Nothing is
// written.
export async function getClassificationsOf(sourceEvidenceId: string, tx: DbClient): Promise<EvidenceClassificationResult<EvidenceClassificationListDto>> {
  if (!isEvidenceClassificationUuid(sourceEvidenceId)) return invalid('invalid revenue source evidence id')
  const id = sourceEvidenceId.toLowerCase()
  if (!(await findSourceForClassification(id, tx))) return { ok: false, code: 'NOT_FOUND', message: 'revenue source evidence not found' }
  return { ok: true, value: { items: (await findClassificationsOfSource(id, tx)).map(toClassificationDto) } }
}

// The public history read, from one READ ONLY snapshot.
export async function listClassifications(sourceEvidenceId: string): Promise<EvidenceClassificationResult<EvidenceClassificationListDto>> {
  if (!isEvidenceClassificationUuid(sourceEvidenceId)) return invalid('invalid revenue source evidence id')
  return withReadSnapshot(undefined, (tx) => getClassificationsOf(sourceEvidenceId, tx))
}

export async function getClassification(classificationId: string): Promise<EvidenceClassificationResult<EvidenceClassificationDto>> {
  if (!isEvidenceClassificationUuid(classificationId)) return invalid('invalid revenue evidence classification id')
  const record = await findClassificationById(classificationId.toLowerCase())
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'revenue evidence classification not found' }
  return { ok: true, value: toClassificationDto(record) }
}
