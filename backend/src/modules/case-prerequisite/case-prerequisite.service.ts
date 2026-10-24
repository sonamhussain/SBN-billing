import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A7.5 consumes, on THIS transaction and unchanged: A7.4 answers the exact immutable case snapshot with
// its recorded, ordered entries; A7.3 answers each linked classification's readiness results. The case is never
// re-assembled, its manifest never recomputed, and no A6.8 lifecycle, A6.9 lineage or newest submission is read.
import { findCaseById, findCaseOwnership } from '../evidence-case/evidence-case.repository.ts'
import { getReadinessOf } from '../evidence-gate/evidence-gate.service.ts'
import { deriveCasePrerequisite, recordedAssessmentAgrees } from './case-prerequisite.reducer.ts'
import {
  findAssessmentById,
  findAssessmentByIdentity,
  findAssessmentsOfCase,
  findCaseForPrerequisite,
  insertAssessment,
  type AssessmentRecord,
} from './case-prerequisite.repository.ts'
import {
  PREREQ_CONTRACT_VERSION,
  type AssessmentCode,
  type AssessmentDto,
  type AssessmentErrorCode,
  type AssessmentListDto,
  type AssessmentOutcome,
  type AssessmentResult,
  type BasisCode,
  type ReadinessFacts,
} from './case-prerequisite.types.ts'
import { isPrerequisiteUuid, validatePrerequisiteBody } from './case-prerequisite.validation.ts'

// A7.5 §5 — an assessment is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Case -> Organization, answered another tenant's case exactly like a missing one,
//    and checked evidenceCasePrereq.create; the body is empty;
// 2. the Claim (case -> frozen submission -> Claim) row lock is the FIRST statement, without waiting (the accepted A6
//    convention); a busy Claim is waited for outside the transaction within a time budget;
// 3. under the lock the case's lock identity and organization are re-read, then the A7.4 owner reads the exact case
//    and its entries and the A7.3 owner the readiness of every linked entry — all on this transaction;
// 4. the one pure reducer derives the outcome and its basis; a contradictory case is a provenance conflict and
//    nothing is recorded;
// 5. an existing assessment of this case and contract is the idempotent answer when it agrees exactly, and a
//    conflict (never a rewrite) when it does not;
// 6. exactly one assessment and one metadata-only audit are appended atomically; the database guard re-derives the
//    outcome from the stored case and re-checks time, organization and the copied case digest.
// Nothing is adjudicated, paid, posted, reconciled, closed or rewritten.

class AssessmentRefusal extends Error {
  readonly code: AssessmentErrorCode
  constructor(code: AssessmentErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: AssessmentErrorCode, message: string): never {
  throw new AssessmentRefusal(code, message)
}

const invalid = (message: string): AssessmentResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const notFound = (): AssessmentResult<never> => ({ ok: false, code: 'NOT_FOUND', message: 'revenue evidence case not found' })

const MAX_ASSESSMENT_ATTEMPTS = 3
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

// The database guard is the backstop behind every service check.
const databaseGuardMarkers = [
  'evidence_prereq_time',
  'evidence_prereq_coherence',
  'evidence_prereq_digest',
  'evidence_prereq_conflict',
  'evidence_prereq_derivation',
  'evidence_prereq_results is append-only',
]

// A lost connection or transaction leaves the outcome unknown: never re-inserted, the caller re-reads.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toAssessmentDto(record: AssessmentRecord): AssessmentDto {
  return {
    assessmentId: record.id,
    caseId: record.evidenceCaseId,
    contractVersion: record.contractVersion,
    assessmentCode: record.assessmentCode as AssessmentCode,
    basisCode: record.basisCode as BasisCode,
    caseManifestSha256: record.caseManifestSha256,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- assess (§5, POST closure-prerequisite-assessments) -------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

// §5 — the stored readiness of every linked entry, through the A7.3 owner, on tx. Only the result the entry names is
// taken; a missing one stays missing (the reducer refuses it, it is never assumed ready).
async function readLinkedReadiness(entries: { classificationId: string | null; readinessId: string | null }[], tx: DbClient): Promise<ReadinessFacts[]> {
  const facts: ReadinessFacts[] = []
  for (const entry of entries) {
    if (entry.classificationId === null || entry.readinessId === null) continue
    const results = await getReadinessOf(entry.classificationId, tx)
    if (!results.ok) return refuse('EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT', 'a linked readiness result could not be read from its owner; nothing was recorded')
    const named = results.value.items.find((item) => item.readinessId === entry.readinessId)
    if (named) facts.push(named)
  }
  return facts
}

async function assessOnTransaction(owner: { claimId: string }, caseId: string, actorUserId: string, tx: DbClient): Promise<AssessmentOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', owner.claimId))) return refuse('NOT_FOUND', 'revenue evidence case not found')
  await concurrencyProbe('casePrerequisite.claim_locked')

  // 3 — the case's lock identity and organization, re-read under the lock, then the exact case through its owner.
  const located = await findCaseForPrerequisite(caseId, tx)
  if (!located || located.claimId !== owner.claimId) return refuse('NOT_FOUND', 'revenue evidence case not found')
  if (located.organizationId !== located.submissionOrganizationId)
    return refuse('EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT', 'the case and its frozen submission do not belong to the same organization; nothing was recorded')
  const stored = await findCaseById(caseId, tx)
  if (!stored) return refuse('NOT_FOUND', 'revenue evidence case not found')
  const readiness = await readLinkedReadiness(stored.entries, tx)

  // 4 — the one pure reducer, from the stored case, its recorded entries and their stored readiness.
  const derived = deriveCasePrerequisite(stored, stored.entries, readiness)
  if (!derived.ok) return refuse('EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT', `${derived.detail}; nothing was recorded`)
  const expected = { ...derived.value, caseManifestSha256: stored.manifestSha256, organizationId: stored.organizationId, contractVersion: PREREQ_CONTRACT_VERSION }

  // 5 — the same identity already recorded: the original assessment when it agrees exactly, never a rewrite. A case
  // is immutable, so a later source never changes it or its assessment.
  const existing = await findAssessmentByIdentity(caseId, PREREQ_CONTRACT_VERSION, tx)
  if (existing) {
    if (!recordedAssessmentAgrees(existing, expected))
      return refuse('EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT', 'the recorded assessment of this case disagrees with its derivation; it was not changed')
    return { replayed: true, assessment: toAssessmentDto(existing) }
  }

  // 6 — one assessment and one business audit, atomically.
  const assessment = await insertAssessment({ ...expected, evidenceCaseId: caseId, recordedByUserId: actorUserId }, tx)
  await concurrencyProbe('casePrerequisite.inserted')
  // §6 — metadata only: ids, contract, the controlled codes and time. No digest, PHI, source, payer value or amount.
  await recordAuditEvent(
    {
      organizationId: assessment.organizationId,
      actorUserId,
      actionCode: 'evidence_case_prerequisite.assessed',
      entityType: 'EVIDENCE_CASE_PREREQUISITE',
      entityId: assessment.id,
      beforeState: null,
      afterState: {
        assessmentId: assessment.id,
        caseId,
        contractVersion: assessment.contractVersion,
        assessmentCode: assessment.assessmentCode,
        basisCode: assessment.basisCode,
        recordedAt: assessment.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('casePrerequisite.audited')
  return { replayed: false, assessment: toAssessmentDto(assessment) }
}

export async function assessClosurePrerequisites(caseId: string, body: unknown, actorUserId: string): Promise<AssessmentResult<AssessmentOutcome>> {
  if (!isPrerequisiteUuid(caseId)) return invalid('invalid revenue evidence case id')
  const validated = validatePrerequisiteBody(body)
  if (!validated.ok) return invalid(validated.message)
  const id = caseId.toLowerCase()
  // The case's frozen submission and Claim never change (every row is immutable), so the Claim is read before the
  // lock for routing only and verified again under it.
  const located = await findCaseForPrerequisite(id, prisma)
  if (!located) return notFound()
  if (!located.claimId) return { ok: false, code: 'EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT', message: 'the case does not resolve to a frozen submission; nothing was recorded' }
  const owner = { claimId: located.claimId }

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => assessOnTransaction(owner, id, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof AssessmentRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EVIDENCE_CASE_PREREQUISITE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(owner.claimId)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_ASSESSMENT_ATTEMPTS) continue
        return { ok: false, code: 'EVIDENCE_CASE_PREREQUISITE_CONFLICT', message: 'concurrent assessment requests for this case kept conflicting; nothing was recorded' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT', message: 'the database refused the assessment as inconsistent with its case; nothing was recorded' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'EVIDENCE_CASE_PREREQUISITE_CONFLICT', message: 'the outcome could not be established; read the case\'s assessment history before requesting again' }
      throw error
    }
  }
}

// ---- reads (§6) ----------------------------------------------------------------------------------------

// A case's assessments on the CALLER's transaction — what later owners consult. Nothing is written.
export async function getPrerequisiteAssessmentsOf(caseId: string, tx: DbClient): Promise<AssessmentResult<AssessmentListDto>> {
  if (!isPrerequisiteUuid(caseId)) return invalid('invalid revenue evidence case id')
  const id = caseId.toLowerCase()
  if (!(await findCaseOwnership(id, tx))) return notFound()
  return { ok: true, value: { items: (await findAssessmentsOfCase(id, tx)).map(toAssessmentDto) } }
}

// The public history read, from one READ ONLY snapshot.
export async function listClosurePrerequisiteAssessments(caseId: string): Promise<AssessmentResult<AssessmentListDto>> {
  if (!isPrerequisiteUuid(caseId)) return invalid('invalid revenue evidence case id')
  return withReadSnapshot(undefined, (tx) => getPrerequisiteAssessmentsOf(caseId, tx))
}

export async function getClosurePrerequisiteAssessment(assessmentId: string): Promise<AssessmentResult<AssessmentDto>> {
  if (!isPrerequisiteUuid(assessmentId)) return invalid('invalid closure-prerequisite assessment id')
  const record = await findAssessmentById(assessmentId.toLowerCase())
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'closure-prerequisite assessment not found' }
  return { ok: true, value: toAssessmentDto(record) }
}
