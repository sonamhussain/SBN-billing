import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A6.9 consumes, each on THIS transaction and unchanged: A6.7 verifies a freeze's integrity (its
// stored bytes still match their digests) and A6.8 derives each freeze's internal disposition.
import { getFrozenSubmission } from '../claim-submission/claim-submission.service.ts'
import { getCurrentLifecycle } from '../claim-lifecycle/claim-lifecycle.service.ts'
import { admitCorrectionLink, orderCorrectionChain } from './claim-correction.chain.ts'
import { findClaimForCorrection, findFreezeFacts, findLinkByCorrected, findLinkById, findLinkByPrior, findLinksOfClaim, insertCorrectionLink, type CorrectionLinkRecord } from './claim-correction.repository.ts'
import {
  CORRECTION_CONTRACT_VERSION,
  type ClaimCorrectionErrorCode,
  type ClaimCorrectionResult,
  type CorrectionLinkDto,
  type CorrectionLinkListDto,
  type CorrectionOutcome,
  type CorrectionReasonCode,
} from './claim-correction.types.ts'
import { isClaimCorrectionUuid, validateCorrectionLinkBody } from './claim-correction.validation.ts'

// A6.9 §6 — a correction link is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Encounter -> Patient -> Organization, answered another
//    tenant's Claim exactly like a missing one, and checked claimCorrection.link; the body is strict;
// 2. the Claim row lock is the FIRST statement, without waiting (the same lock every A6.2–A6.8 writer takes);
//    a busy Claim is waited for outside the transaction and the request starts again on a fresh snapshot;
// 3. under the lock both freezes are re-read through the A6.7 owner (another Claim's or a missing freeze is
//    a 404; bytes that no longer match their digests are a conflict); an exact existing link is the
//    idempotent answer (same reason -> 200 replay, another reason -> refused);
// 4. both A6.8 histories must be trustworthy (the disposition does not gate a link and is never changed);
//    the Claim's links must form one linear chain; the pure admission rule checks distinct assessments,
//    strict database chronology and growth at the chain's tail;
// 5. exactly one link and one metadata-only audit are appended atomically; the database guard re-checks
//    time, same Claim, assessment, chronology and chain.
// Nothing is sent, resubmitted, withdrawn, released or rewritten.

class CorrectionRefusal extends Error {
  readonly code: ClaimCorrectionErrorCode
  constructor(code: ClaimCorrectionErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClaimCorrectionErrorCode, message: string): never {
  throw new CorrectionRefusal(code, message)
}

const invalid = (message: string): ClaimCorrectionResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_LINK_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished.
const MAX_LOCK_WAITS = 5

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer (Prisma: P2034); a deadlock is retried the same way, on a fresh transaction.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE prior/correction keys refuse a colliding writer; the retry re-reads (the replay or a refusal).
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = ['claim_correction_time', 'claim_correction_coherence', 'claim_correction_chronology', 'claim_correction_chain', 'claim_correction_links is append-only']

// A lost connection or transaction leaves the outcome unknown: never re-appended, the caller re-reads.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toLinkDto(record: CorrectionLinkRecord): CorrectionLinkDto {
  return {
    correctionLinkId: record.id,
    claimId: record.claimId,
    priorSubmissionId: record.priorSubmissionId,
    correctedSubmissionId: record.correctedSubmissionId,
    reasonCode: record.reasonCode as CorrectionReasonCode,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
    contractVersion: record.contractVersion,
  }
}

// A6.7 verifies the frozen bytes against their digests; a mismatch is an integrity conflict, never repaired.
async function readFreezeThroughOwner(claimId: string, submissionId: string, tx: DbClient) {
  try {
    return await getFrozenSubmission(claimId, submissionId, tx)
  } catch (error) {
    if (error instanceof Error && /do not match their stored digests/.test(error.message)) return refuse('CLAIM_CORRECTION_CONFLICT', 'a frozen submission no longer matches its stored digests; nothing was linked')
    throw error
  }
}

// ---- record a link (§6, POST correction-links) ----------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function linkOnTransaction(claimId: string, priorId: string, correctedId: string, reasonCode: CorrectionReasonCode, actorUserId: string, tx: DbClient): Promise<CorrectionOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', 'claim not found')
  await concurrencyProbe('claimCorrection.claim_locked')
  const claim = await findClaimForCorrection(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', 'claim not found')

  // 3 — both freezes through their owner; another Claim's freeze is answered like a missing one.
  const prior = await readFreezeThroughOwner(claimId, priorId, tx)
  if (!prior) return refuse('NOT_FOUND', 'prior claim submission not found')
  const corrected = await readFreezeThroughOwner(claimId, correctedId, tx)
  if (!corrected) return refuse('NOT_FOUND', 'corrected claim submission not found')

  // The exact pair already linked is the idempotent answer; the same pair with another reason is refused.
  const startingHere = await findLinkByPrior(priorId, tx)
  if (startingHere && startingHere.correctedSubmissionId === correctedId) {
    if (startingHere.reasonCode !== reasonCode) return refuse('CLAIM_CORRECTION_NOT_ALLOWED', 'this correction is already recorded with another reason; nothing was linked')
    return { replayed: true, link: toLinkDto(startingHere) }
  }
  if (startingHere) return refuse('CLAIM_CORRECTION_NOT_ALLOWED', 'the prior freeze is already corrected by another freeze (no fork); nothing was linked')
  if (await findLinkByCorrected(correctedId, tx)) return refuse('CLAIM_CORRECTION_NOT_ALLOWED', 'the corrected freeze already corrects another freeze (no join); nothing was linked')

  // 4 — both A6.8 histories must be trustworthy; the disposition itself never gates or changes.
  for (const submissionId of [priorId, correctedId]) {
    const lifecycle = await getCurrentLifecycle(submissionId, tx)
    if (!lifecycle.ok) return refuse('CLAIM_CORRECTION_CONFLICT', `the internal lifecycle of a freeze cannot be trusted (${lifecycle.code}); nothing was linked`)
  }
  const chain = orderCorrectionChain(await findLinksOfClaim(claimId, tx))
  if (!chain.ok) return refuse('CLAIM_CORRECTION_CONFLICT', `this claim's correction history cannot be trusted (${chain.reason}); nothing was linked`)
  const priorFacts = await findFreezeFacts(priorId, tx)
  const correctedFacts = await findFreezeFacts(correctedId, tx)
  if (!priorFacts || !correctedFacts || priorFacts.id !== prior.submission.submissionId || correctedFacts.id !== corrected.submission.submissionId)
    return refuse('CLAIM_CORRECTION_CONFLICT', 'the freezes could not be read consistently; nothing was linked')
  const admitted = admitCorrectionLink(chain.submissions, priorFacts, correctedFacts)
  if (!admitted.ok) return refuse('CLAIM_CORRECTION_NOT_ALLOWED', `${admitted.reason}; nothing was linked`)

  // 5 — one link and one business audit, atomically.
  const link = await insertCorrectionLink(
    { claimId, priorSubmissionId: priorId, correctedSubmissionId: correctedId, reasonCode, recordedByUserId: actorUserId, contractVersion: CORRECTION_CONTRACT_VERSION },
    tx,
  )
  await concurrencyProbe('claimCorrection.inserted')
  // §7 — metadata only: ids, reason, contract and time. No PHI, bytes, digests, amounts or free text.
  await recordAuditEvent(
    {
      organizationId: claim.organizationId,
      actorUserId,
      actionCode: 'claim_correction.linked',
      entityType: 'CLAIM_CORRECTION_LINK',
      entityId: link.id,
      beforeState: null,
      afterState: {
        correctionLinkId: link.id,
        claimId,
        priorSubmissionId: priorId,
        correctedSubmissionId: correctedId,
        reasonCode,
        contractVersion: CORRECTION_CONTRACT_VERSION,
        recordedAt: link.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('claimCorrection.audited')
  return { replayed: false, link: toLinkDto(link) }
}

export async function recordCorrectionLink(claimId: string, body: unknown, actorUserId: string): Promise<ClaimCorrectionResult<CorrectionOutcome>> {
  if (!isClaimCorrectionUuid(claimId)) return invalid('invalid claim id')
  const validated = validateCorrectionLinkBody(body)
  if (!validated.ok) return invalid(validated.message)
  const { priorSubmissionId, correctedSubmissionId, reasonCode } = validated.value
  const id = claimId.toLowerCase()

  let lockWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => linkOnTransaction(id, priorSubmissionId, correctedSubmissionId, reasonCode, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof CorrectionRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        lockWaits += 1
        if (lockWaits > MAX_LOCK_WAITS) return { ok: false, code: 'CLAIM_CORRECTION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was linked' }
        await waitForClaimLock(id)
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_LINK_ATTEMPTS) continue
        return { ok: false, code: 'CLAIM_CORRECTION_CONFLICT', message: 'concurrent correction decisions on this claim kept conflicting; nothing was linked' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'CLAIM_CORRECTION_CONFLICT', message: 'the database refused the link as inconsistent with this claim\'s history; nothing was linked' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'CLAIM_CORRECTION_CONFLICT', message: 'the outcome could not be established; read the correction history before deciding again' }
      throw error
    }
  }
}

// ---- reads (§7) ----------------------------------------------------------------------------------------

// The Claim's correction chain in chain order (root to tail) on the CALLER's transaction — the lineage later
// owners (A9) consult. A history the chain logic cannot trust is a conflict, never a guess. Nothing is written.
export async function getCorrectionChain(claimId: string, tx: DbClient): Promise<ClaimCorrectionResult<CorrectionLinkListDto>> {
  if (!isClaimCorrectionUuid(claimId)) return invalid('invalid claim id')
  const id = claimId.toLowerCase()
  if (!(await findClaimForCorrection(id, tx))) return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
  const chain = orderCorrectionChain(await findLinksOfClaim(id, tx))
  if (!chain.ok) return { ok: false, code: 'CLAIM_CORRECTION_CONFLICT', message: `this claim's correction history cannot be trusted (${chain.reason})` }
  return { ok: true, value: { items: chain.links.map(toLinkDto) } }
}

// The public history read: the chain from one READ ONLY snapshot.
export async function listCorrectionLinks(claimId: string): Promise<ClaimCorrectionResult<CorrectionLinkListDto>> {
  if (!isClaimCorrectionUuid(claimId)) return invalid('invalid claim id')
  return withReadSnapshot(undefined, (tx) => getCorrectionChain(claimId, tx))
}

export async function getCorrectionLink(linkId: string): Promise<ClaimCorrectionResult<CorrectionLinkDto>> {
  if (!isClaimCorrectionUuid(linkId)) return invalid('invalid claim correction link id')
  const record = await findLinkById(linkId.toLowerCase())
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'claim correction link not found' }
  return { ok: true, value: toLinkDto(record) }
}
