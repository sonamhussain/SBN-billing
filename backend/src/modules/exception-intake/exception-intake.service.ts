import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A8.1 consumes, on THIS transaction and unchanged: the A6.7 Claim ownership path and a Claim's freezes,
// the A6.9 freeze instants and correction links, the A7.4 stored case, the A7.5 stored assessment and its case ->
// frozen submission -> Claim identity, the A7.6 trace of an assessment and the A7.7 timeline of a Claim. Their
// verdicts and stored facts are taken as answered; nothing is re-derived, repaired or written to them.
import { findClaimForFreeze, findFreezesOfClaim } from '../claim-submission/claim-submission.repository.ts'
import { findFreezeFacts, findLinksOfClaim } from '../claim-correction/claim-correction.repository.ts'
import { findCaseById } from '../evidence-case/evidence-case.repository.ts'
import { findAssessmentById, findCaseForPrerequisite } from '../case-prerequisite/case-prerequisite.repository.ts'
import { getClosureBasisTraceOf } from '../closure-basis-trace/closure-basis-trace.service.ts'
import { getRevenueTimelineOf } from '../revenue-timeline/revenue-timeline.service.ts'
import { establishedBasis } from './exception-intake.basis.ts'
import { identityKeyOf } from './exception-intake.identity.ts'
import { findIntakeByIdentity, findIntakesOfClaim, insertIntake, type IntakeRecord } from './exception-intake.repository.ts'
import {
  EXCEPTION_INTAKE_CONTRACT_VERSION,
  type BasisCode,
  type ExceptionIntakeDto,
  type ExceptionIntakeErrorCode,
  type ExceptionIntakeListDto,
  type ExceptionIntakeOutcome,
  type ExceptionIntakeResult,
  type ExceptionReasonCode,
  type FreezeInstant,
  type IdentityParts,
  type IntakeRequest,
  type LinkEdge,
  type OwnerVerdict,
  type SourceKind,
} from './exception-intake.types.ts'
import { isIntakeUuid, validateIntakeRequest } from './exception-intake.validation.ts'

// A8.1 §5/§6 — an intake is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    and checked exceptionIntake.create; the body is exactly the four controlled fields;
// 2. the Claim row lock is the FIRST statement, without waiting (the accepted convention); a busy Claim is waited for
//    outside the transaction within a time budget;
// 3. under the lock the Claim's organization is re-read, and the exact source is resolved through its owner: it must
//    exist and belong to exactly this Claim and organization under its stored contract (otherwise the same 404 as a
//    missing record);
// 4. an intake with the same deterministic identity is the idempotent answer (200, no new row, no audit) — only after
//    every canonical field of the stored row is verified to be exactly the request's and this tenant's, and its
//    identity key the digest of its own columns; anything else is refused, never answered;
// 5. otherwise the source's owners answer their verdict and stored facts on this transaction, and the pure basis rule
//    says whether the reason's specific condition holds and by which controlled basis; an owner's refusal alone, or
//    any condition it cannot prove, is refused (409 INTAKE_BASIS_NOT_ESTABLISHED), never stored;
// 6. exactly one intake (with its basis) and one metadata-only audit are appended atomically; the database guard
//    re-checks time, organization, membership, source coherence, the copied digest, the basis fact and the identity.
// Nothing is assigned, resolved, closed, paid, denied or changed in any source.

class IntakeRefusal extends Error {
  readonly code: ExceptionIntakeErrorCode
  constructor(code: ExceptionIntakeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ExceptionIntakeErrorCode, message: string): never {
  throw new IntakeRefusal(code, message)
}

const invalid = (message: string): ExceptionIntakeResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const NOT_FOUND_MESSAGE = 'claim or source record not found'
const notFound = (): ExceptionIntakeResult<never> => ({ ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE })

const MAX_INTAKE_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the request starts again once the writer has finished. The waits are
// bounded by time, not by a small count, so identical requests released together cannot starve each other; a short
// random pause after each wait breaks that lock-step (timing only, never an outcome).
const LOCK_WAIT_BUDGET_MS = 30_000
const pauseAfterLockWait = () => new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)))

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a competing
// writer (Prisma: P2034); a deadlock is retried the same way, on a fresh transaction that re-reads everything.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The UNIQUE identity refuses a colliding writer; the retry re-reads and answers the replay.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guard is the backstop behind every service check.
const databaseGuardMarkers = ['exception_intake_time', 'exception_intake_coherence', 'exception_intake_member', 'exception_intake_source', 'exception_intake_basis', 'exception_intake_identity', 'exception_intake_records is append-only']

// A lost connection or transaction leaves the outcome unknown: never re-inserted blindly; the exact identity is
// re-read instead.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toIntakeDto(record: IntakeRecord): ExceptionIntakeDto {
  return {
    exceptionIntakeId: record.id,
    contractVersion: record.contractVersion,
    organizationId: record.organizationId,
    claimId: record.claimId,
    sourceKind: record.sourceKind as SourceKind,
    sourceRecordId: record.sourceRecordId,
    sourceContractVersion: record.sourceContractVersion,
    sourceFingerprintSha256: record.sourceFingerprintSha256,
    exceptionReasonCode: record.exceptionReasonCode as ExceptionReasonCode,
    basisCode: record.basisCode as BasisCode,
    basisRecordId: record.basisRecordId,
    identityKey: record.identityKey,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

// ---- record (§5, POST exception-intake) ---------------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

// §5 — the exact source through its owner, and that owner's verdict and stored facts, on tx. A source of another
// Claim or organization is answered exactly like a missing one. The digest is the owner's stored one or null — never
// made up. The facts behind a refusal are read only when the owner refused, and only identifiers, instants and codes.
async function resolveSource(request: IntakeRequest, claimId: string, organizationId: string, tx: DbClient): Promise<{ verdict: OwnerVerdict; fingerprint: string | null }> {
  if (request.sourceKind === 'REVENUE_TIMELINE') {
    if (request.sourceRecordId !== claimId) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
    const timeline = await getRevenueTimelineOf(claimId, tx)
    if (!timeline.ok && timeline.code === 'NOT_FOUND') return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
    const freezes: FreezeInstant[] = []
    const links: LinkEdge[] = []
    if (!timeline.ok) {
      // Every A6.7 freeze of the Claim with its database instant in microseconds (the A6.9 freeze facts; an instant
      // the owner cannot answer for this Claim stays unknown and proves nothing), and every A6.9 link of the Claim.
      for (const freeze of await findFreezesOfClaim(claimId, tx)) {
        const facts = await findFreezeFacts(freeze.id, tx)
        freezes.push({ submissionId: freeze.id, frozenAtMicros: facts && facts.claimId === claimId ? facts.frozenAtMicros : Number.NaN })
      }
      for (const link of await findLinksOfClaim(claimId, tx)) links.push({ id: link.id, priorSubmissionId: link.priorSubmissionId, correctedSubmissionId: link.correctedSubmissionId })
    }
    return { verdict: { kind: 'REVENUE_TIMELINE', timelineCode: timeline.ok ? 'OK' : timeline.code, freezes, links }, fingerprint: null }
  }
  const assessment = await findAssessmentById(request.sourceRecordId, tx)
  if (!assessment || assessment.organizationId !== organizationId) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const located = await findCaseForPrerequisite(assessment.evidenceCaseId, tx)
  if (!located || located.claimId !== claimId) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  if (assessment.contractVersion !== request.sourceContractVersion)
    return refuse('INTAKE_BASIS_NOT_ESTABLISHED', 'the source is not recorded under the stated contract; nothing was recorded')
  const trace = await getClosureBasisTraceOf(assessment.id, tx)
  if (!trace.ok && trace.code === 'NOT_FOUND') return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  // The assessed case's stored digest through the A7.4 owner, read only when the trace was refused.
  const assessedCase = trace.ok ? null : await findCaseById(assessment.evidenceCaseId, tx)
  return {
    verdict: {
      kind: 'CLOSURE_PREREQUISITE_ASSESSMENT',
      traceCode: trace.ok ? 'OK' : trace.code,
      assessmentId: assessment.id,
      assessmentCode: assessment.assessmentCode,
      assessmentOrganizationId: assessment.organizationId,
      assessmentCaseDigest: assessment.caseManifestSha256,
      caseId: assessment.evidenceCaseId,
      caseOrganizationId: located.organizationId,
      caseManifestSha256: assessedCase?.manifestSha256 ?? null,
    },
    fingerprint: assessment.caseManifestSha256,
  }
}

// §6 / D5 — a stored intake answers a replay only when every canonical field is exactly the request's and this
// tenant's, under this contract, and its identity key is the digest of its own stored columns.
function isCanonicalReplay(record: IntakeRecord, parts: IdentityParts): boolean {
  let ownKey = ''
  try {
    ownKey = identityKeyOf({
      organizationId: record.organizationId,
      claimId: record.claimId,
      sourceKind: record.sourceKind,
      sourceRecordId: record.sourceRecordId,
      sourceContractVersion: record.sourceContractVersion,
      exceptionReasonCode: record.exceptionReasonCode,
    })
  } catch {
    return false
  }
  return (
    record.contractVersion === EXCEPTION_INTAKE_CONTRACT_VERSION &&
    record.organizationId === parts.organizationId &&
    record.claimId === parts.claimId &&
    record.sourceKind === parts.sourceKind &&
    record.sourceRecordId === parts.sourceRecordId &&
    record.sourceContractVersion === parts.sourceContractVersion &&
    record.exceptionReasonCode === parts.exceptionReasonCode &&
    record.identityKey === identityKeyOf(parts) &&
    ownKey === record.identityKey
  )
}

const REPLAY_MISMATCH = 'a stored intake with this identity does not match the request; nothing was recorded'

async function recordOnTransaction(claimId: string, request: IntakeRequest, actorUserId: string, tx: DbClient): Promise<ExceptionIntakeOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  await concurrencyProbe('exceptionIntake.claim_locked')

  // 3 — the Claim's organization, re-read under the lock, then the exact source through its owner.
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', NOT_FOUND_MESSAGE)
  const { verdict, fingerprint } = await resolveSource(request, claimId, claim.organizationId, tx)

  // 4 — the same identity already recorded: the original intake, never a rewrite. A recorded intake is a historical
  // fact of its own time, so the exact repeated request answers it even after its source later changed.
  const parts = { organizationId: claim.organizationId, claimId, sourceKind: request.sourceKind, sourceRecordId: request.sourceRecordId, sourceContractVersion: request.sourceContractVersion, exceptionReasonCode: request.exceptionReasonCode }
  const identityKey = identityKeyOf(parts)
  const existing = await findIntakeByIdentity(identityKey, tx)
  if (existing) {
    if (!isCanonicalReplay(existing, parts)) return refuse('EXCEPTION_INTAKE_CONFLICT', REPLAY_MISMATCH)
    return { replayed: true, intake: toIntakeDto(existing) }
  }

  // 5 — only a reason whose specific condition the owners' facts prove NOW is admissible for a new intake.
  const basis = establishedBasis(verdict, request.exceptionReasonCode)
  if (!basis) return refuse('INTAKE_BASIS_NOT_ESTABLISHED', `the source's owners do not prove ${request.exceptionReasonCode} for this record; nothing was recorded`)

  // 6 — one intake and one business audit, atomically.
  const intake = await insertIntake(
    { ...parts, contractVersion: EXCEPTION_INTAKE_CONTRACT_VERSION, sourceFingerprintSha256: fingerprint, basisCode: basis.basisCode, basisRecordId: basis.basisRecordId, identityKey, recordedByUserId: actorUserId },
    tx,
  )
  await concurrencyProbe('exceptionIntake.inserted')
  // §6 — metadata only: ids, contract, the controlled codes, the basis and time. No digest, PHI, payload, payer value,
  // owner message or amount.
  await recordAuditEvent(
    {
      organizationId: intake.organizationId,
      actorUserId,
      actionCode: 'exception_intake.recorded',
      entityType: 'EXCEPTION_INTAKE',
      entityId: intake.id,
      beforeState: null,
      afterState: {
        exceptionIntakeId: intake.id,
        claimId,
        contractVersion: intake.contractVersion,
        sourceKind: intake.sourceKind,
        sourceRecordId: intake.sourceRecordId,
        sourceContractVersion: intake.sourceContractVersion,
        exceptionReasonCode: intake.exceptionReasonCode,
        basisCode: intake.basisCode,
        basisRecordId: intake.basisRecordId,
        recordedAt: intake.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('exceptionIntake.audited')
  return { replayed: false, intake: toIntakeDto(intake) }
}

export async function recordExceptionIntake(claimId: string, body: unknown, actorUserId: string): Promise<ExceptionIntakeResult<ExceptionIntakeOutcome>> {
  if (!isIntakeUuid(claimId)) return invalid('invalid claim id')
  const validated = validateIntakeRequest(body)
  if (!validated.ok) return invalid(validated.message)
  const id = claimId.toLowerCase()
  const request = validated.value

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => recordOnTransaction(id, request, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof IntakeRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'EXCEPTION_INTAKE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(id)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_INTAKE_ATTEMPTS) continue
        return { ok: false, code: 'EXCEPTION_INTAKE_CONFLICT', message: 'concurrent intake requests for this claim kept conflicting; nothing was recorded' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'EXCEPTION_INTAKE_CONFLICT', message: 'the database refused the intake as inconsistent with its claim or source; nothing was recorded' }
      if (isUnknownOutcome(error)) return outcomeAfterUnknownCommit(id, request)
      throw error
    }
  }
}

// The intake on the CALLER's transaction (no retry, no lock wait): what a later owner composing its own transaction
// calls, and what a harness-held transaction judges. A refusal is answered, never thrown.
export async function recordExceptionIntakeOn(claimId: string, body: unknown, actorUserId: string, tx: DbClient): Promise<ExceptionIntakeResult<ExceptionIntakeOutcome>> {
  if (!isIntakeUuid(claimId)) return invalid('invalid claim id')
  const validated = validateIntakeRequest(body)
  if (!validated.ok) return invalid(validated.message)
  try {
    return { ok: true, value: await recordOnTransaction(claimId.toLowerCase(), validated.value, actorUserId, tx) }
  } catch (error) {
    if (error instanceof IntakeRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// §6 — after an unknown commit outcome the request is never repeated blindly: the exact identity is re-read on a new
// connection. Found and canonical, it is the recorded intake (answered as a replay); otherwise the outcome stays
// unknown.
async function outcomeAfterUnknownCommit(claimId: string, request: IntakeRequest): Promise<ExceptionIntakeResult<ExceptionIntakeOutcome>> {
  const unknown: ExceptionIntakeResult<never> = { ok: false, code: 'EXCEPTION_INTAKE_CONFLICT', message: "the outcome could not be established; read the claim's exception intakes before requesting again" }
  try {
    const claim = await findClaimForFreeze(claimId, prisma)
    if (!claim) return unknown
    const parts = { organizationId: claim.organizationId, claimId, ...request }
    const found = await findIntakeByIdentity(identityKeyOf(parts), prisma)
    return found && isCanonicalReplay(found, parts) ? { ok: true, value: { replayed: true, intake: toIntakeDto(found) } } : unknown
  } catch {
    return unknown
  }
}

// ---- reads (§6) ----------------------------------------------------------------------------------------

// A Claim's intakes on the CALLER's transaction — what later A8 owners consult. Nothing is written.
export async function getExceptionIntakesOf(claimId: string, tx: DbClient): Promise<ExceptionIntakeResult<ExceptionIntakeListDto>> {
  if (!isIntakeUuid(claimId)) return invalid('invalid claim id')
  const id = claimId.toLowerCase()
  if (!(await findClaimForFreeze(id, tx))) return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
  return { ok: true, value: { items: (await findIntakesOfClaim(id, tx)).map(toIntakeDto) } }
}

// The public history read, from one READ ONLY snapshot.
export async function listExceptionIntakes(claimId: string): Promise<ExceptionIntakeResult<ExceptionIntakeListDto>> {
  if (!isIntakeUuid(claimId)) return invalid('invalid claim id')
  return withReadSnapshot(undefined, (tx) => getExceptionIntakesOf(claimId, tx))
}
