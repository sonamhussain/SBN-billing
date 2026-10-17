import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// A6.4 owns draft assembly, reduction and the assembly fingerprint. A6.5 calls its transaction-aware
// composer on the same snapshot as every other read and never re-implements any part of it.
import { composeCurrentDraft } from '../claim-draft/claim-draft.service.ts'
import { admitDecision, auditActionOf, deriveAuthority, nextSequence, type Currentness, type LatestDecision } from './claim-review.policy.ts'
import { createDecisionRecord, findAssessmentForReview, findClaimForReview, findDecisionById, findDecisionsOfClaim, findLatestDecision } from './claim-review.repository.ts'
import {
  REVIEW_CONTRACT_VERSION,
  type ClaimReviewErrorCode,
  type ClaimReviewResult,
  type RecordedReviewDecisionDto,
  type ReviewAuthorityDto,
  type ReviewDecisionCode,
  type ReviewDecisionDto,
  type ReviewDecisionListDto,
  type ReviewReasonCode,
} from './claim-review.types.ts'
import { isClaimReviewUuid, validateReviewDecisionBody } from './claim-review.validation.ts'

// A6.5 §5/§6 — a review decision is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Encounter -> Patient -> Organization, answered another
//    tenant's Claim exactly like a missing one, and checked the reviewer's permission for this decision;
// 2. the Claim row lock is the FIRST statement, without waiting (the same lock every A6.2 structure
//    writer, A6.3 pricing run and A6.4 assessment takes), so the snapshot never predates a writer it would
//    have waited for; a busy Claim is waited for outside the transaction and the decision starts again;
// 3. the requested A6.4 assessment, the Claim's latest decision and the derived authority are read, and
//    an APPROVE recomposes the reviewed draft through the A6.4 owner on that same transaction;
// 4. the decision is appended at the next Claim-local sequence with one business audit, atomically;
// 5. the response is the immutable decision and the authority derived after it, on the same snapshot.
// Nothing creates a ClaimSubmission, payload, payload hash or transport job.

class ReviewRefusal extends Error {
  readonly code: ClaimReviewErrorCode
  constructor(code: ClaimReviewErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClaimReviewErrorCode, message: string): never {
  throw new ReviewRefusal(code, message)
}

const invalid = (message: string): ClaimReviewResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_DECISION_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the decision starts again once the writer has finished, a
// bounded number of times.
const MAX_LOCK_WAITS = 5

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer (Prisma: P2034); a deadlock is retried the same way. Nothing else is retried.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = ['claim_review_decision_coherence', 'claim_review_decision_sequence', 'claim_review_decision_time', 'claim_review_separation', 'claim_review_events is append-only']
// The unique keys (Claim + sequence, one revocation per approval) refuse a colliding write.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

const transactionTime = async (tx: DbClient) => (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now

// ---- derived authority (§6) ----------------------------------------------------------------------

async function currentnessOf(claimId: string, pricingRunId: string, tx: DbClient): Promise<Currentness> {
  const composed = await composeCurrentDraft(claimId, pricingRunId, tx)
  return composed.ok ? { outcome: composed.value.outcome, assemblyFingerprint: composed.value.assemblyFingerprint } : null
}

async function authorityFor(claimId: string, latest: LatestDecision, tx: DbClient) {
  let currentness: Currentness = null
  if (latest?.decisionCode === 'APPROVE') {
    const approved = await findAssessmentForReview(latest.draftAssessmentId, tx)
    currentness = approved ? await currentnessOf(claimId, approved.pricingRunId, tx) : null
  }
  return deriveAuthority(latest, currentness)
}

// The current review authority of a Claim, derived on the CALLER's transaction: the latest decision by
// sequence and, for an APPROVE, a fresh A6.4 recomposition of its reviewed draft on the same snapshot. Only
// APPROVED_CURRENT grants anything. A later freeze gate (A6.7) calls this inside its own guarded write.
export async function getCurrentReviewAuthority(claimId: string, tx: DbClient): Promise<ReviewAuthorityDto> {
  const derived = await authorityFor(claimId, await findLatestDecision(claimId, tx), tx)
  return { claimId, ...derived, evaluatedAt: (await transactionTime(tx)).toISOString() }
}

// ---- DTOs --------------------------------------------------------------------------------------------

type DecisionRecord = NonNullable<Awaited<ReturnType<typeof findDecisionById>>>

function toDecisionDto(record: DecisionRecord): ReviewDecisionDto {
  return {
    id: record.id,
    claimId: record.claimId,
    draftAssessmentId: record.draftAssessmentId,
    reviewerUserId: record.reviewerUserId,
    decisionCode: record.decisionCode as ReviewDecisionCode,
    sequence: record.sequence,
    approvalFingerprint: record.approvalFingerprint,
    reasonCode: record.reasonCode as ReviewReasonCode | null,
    referencedApprovalId: record.referencedApprovalId,
    reviewContractVersion: record.reviewContractVersion,
    reviewedAt: record.reviewedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  }
}

// ---- decision (§8 POST review-decisions) -------------------------------------------------------------

// Waits, outside any decision transaction, until the current holder of the Claim lock has finished. The
// lock is released at once; it only orders this decision after that writer.
async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

export async function recordReviewDecision(claimId: string, body: unknown, actorUserId: string): Promise<ClaimReviewResult<RecordedReviewDecisionDto>> {
  if (!isClaimReviewUuid(claimId)) return invalid('invalid claim id')
  const validated = validateReviewDecisionBody(body)
  if (!validated.ok) return invalid(validated.message)
  const request = validated.value

  let lockWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction(
        async (tx) => {
          if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', 'claim not found')
          await concurrencyProbe('claimReview.claim_locked')
          const claim = await findClaimForReview(claimId, tx)
          if (!claim) return refuse('NOT_FOUND', 'claim not found')
          // An assessment of another Claim (of this or any organization) is answered exactly like a missing
          // one, so nothing about it is disclosed and nothing is substituted.
          const assessment = await findAssessmentForReview(request.draftAssessmentId, tx)
          if (!assessment || assessment.claimId !== claimId) return refuse('NOT_FOUND', 'claim draft assessment not found')

          const latest = await findLatestDecision(claimId, tx)
          const before = await authorityFor(claimId, latest, tx)
          const admitted = admitDecision({
            request,
            reviewerUserId: actorUserId,
            claimCreatorUserId: claim.createdByUserId,
            assessment,
            latest,
            authority: before.state,
            requestedCurrentness: request.decisionCode === 'APPROVE' ? await currentnessOf(claimId, assessment.pricingRunId, tx) : null,
          })
          if (!admitted.ok) return refuse(admitted.code, admitted.message)

          const decision = await createDecisionRecord(
            {
              claimId,
              draftAssessmentId: assessment.id,
              reviewerUserId: actorUserId,
              decisionCode: request.decisionCode,
              sequence: nextSequence(latest),
              approvalFingerprint: request.decisionCode === 'APPROVE' ? assessment.assemblyFingerprint : null,
              reasonCode: request.reasonCode,
              referencedApprovalId: request.referencedApprovalId,
              reviewContractVersion: REVIEW_CONTRACT_VERSION,
            },
            tx,
          )
          await concurrencyProbe('claimReview.inserted')
          // §10 — metadata only: no patient, diagnosis, code text, amount, fingerprint or remark.
          await recordAuditEvent(
            {
              organizationId: claim.organizationId,
              actorUserId,
              actionCode: auditActionOf(request.decisionCode),
              entityType: 'CLAIM_REVIEW_DECISION',
              entityId: decision.id,
              beforeState: null,
              afterState: {
                id: decision.id,
                claimId,
                draftAssessmentId: decision.draftAssessmentId,
                decisionCode: decision.decisionCode,
                sequence: decision.sequence,
                reasonCode: decision.reasonCode,
                referencedApprovalId: decision.referencedApprovalId,
                reviewContractVersion: decision.reviewContractVersion,
              },
            },
            tx,
          )
          await concurrencyProbe('claimReview.audited')
          return { decision: toDecisionDto(decision), authority: await getCurrentReviewAuthority(claimId, tx) }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000 },
      )
      return { ok: true, value }
    } catch (error) {
      if (error instanceof ReviewRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        lockWaits += 1
        if (lockWaits > MAX_LOCK_WAITS) return { ok: false, code: 'CLAIM_REVIEW_CONFLICT', message: 'the claim stayed busy with other changes; nothing was written' }
        await waitForClaimLock(claimId)
        continue
      }
      if (isWriteConflict(error)) {
        attempt += 1
        if (attempt <= MAX_DECISION_ATTEMPTS) continue
        return { ok: false, code: 'CLAIM_REVIEW_CONFLICT', message: 'concurrent changes to this claim kept conflicting with the decision; nothing was written' }
      }
      if (isUniqueViolation(error) || (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker))))
        return { ok: false, code: 'INTEGRITY_CONFLICT', message: 'the database refused the review decision as inconsistent with this claim\'s history; nothing was written' }
      throw error
    }
  }
}

// ---- reads (§6, §8) ----------------------------------------------------------------------------------

export async function listReviewDecisions(claimId: string): Promise<ClaimReviewResult<ReviewDecisionListDto>> {
  if (!isClaimReviewUuid(claimId)) return invalid('invalid claim id')
  // One READ ONLY snapshot: the whole history in sequence order, from one committed state.
  return withReadSnapshot(undefined, async (tx) => {
    if (!(await findClaimForReview(claimId, tx))) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'claim not found' }
    return { ok: true as const, value: { items: (await findDecisionsOfClaim(claimId, tx)).map(toDecisionDto) } }
  })
}

export async function getReviewAuthority(claimId: string): Promise<ClaimReviewResult<ReviewAuthorityDto>> {
  if (!isClaimReviewUuid(claimId)) return invalid('invalid claim id')
  // Read-only: the latest decision and the A6.4 recomposition come from the same snapshot; nothing is
  // written, so a read can never grant or refresh authority.
  return withReadSnapshot(undefined, async (tx) => {
    if (!(await findClaimForReview(claimId, tx))) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'claim not found' }
    return { ok: true as const, value: await getCurrentReviewAuthority(claimId, tx) }
  })
}

export async function getReviewDecision(id: string): Promise<ClaimReviewResult<ReviewDecisionDto>> {
  if (!isClaimReviewUuid(id)) return invalid('invalid claim review decision id')
  const record = await findDecisionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'claim review decision not found' }
  return { ok: true, value: toDecisionDto(record) }
}
