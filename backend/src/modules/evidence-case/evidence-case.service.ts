import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A7.4 consumes, on THIS transaction and unchanged: A6.7 verifies the frozen submission's stored digests,
// A7.1 lists its registered sources in database-recorded order, A7.2 answers each source's classifications and A7.3
// each classification's readiness results. Nothing is re-derived; no A6.8 lifecycle or A6.9 lineage is read.
import { getFrozenSubmission } from '../claim-submission/claim-submission.service.ts'
import { findSubmissionForRevenueEvidence } from '../revenue-evidence/revenue-evidence.repository.ts'
import { getRevenueSourceEvidenceOf } from '../revenue-evidence/revenue-evidence.service.ts'
import { getClassificationsOf } from '../evidence-classification/evidence-classification.service.ts'
import { getReadinessOf } from '../evidence-gate/evidence-gate.service.ts'
import { assembleCase } from './evidence-case.assembler.ts'
import { findCaseById, findCaseByIdentity, findCasesOfSubmission, insertCaseEntries, insertCaseHeader, type CaseHeaderRecord, type CaseRecord } from './evidence-case.repository.ts'
import {
  CASE_CONTRACT_VERSION,
  type AssemblyCode,
  type CaseDto,
  type CaseErrorCode,
  type CaseHeaderDto,
  type CaseListDto,
  type CaseOutcome,
  type CaseResult,
  type ItemReasonCode,
  type SourceLinks,
} from './evidence-case.types.ts'
import { isCaseUuid, validateCaseBody } from './evidence-case.validation.ts'

// A7.4 §7 — a case snapshot is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Submission -> Organization, answered another tenant's submission exactly like a
//    missing one, and checked evidenceCase.create; the body is empty;
// 2. the submission's Claim row lock is the FIRST statement, without waiting (the accepted A6 convention); a busy
//    Claim is waited for outside the transaction within a time budget;
// 3. under the lock A6.7 verifies the frozen submission, A7.1 lists its sources, A7.2 each source's classifications
//    and A7.3 each classification's readiness results — all on this transaction;
// 4. the one pure assembler builds the ordered inventory and its manifest; a broken or contradictory link is a
//    provenance conflict and nothing is recorded;
// 5. an existing snapshot of this submission and contract is the idempotent answer, exactly as recorded — a later
//    source never mutates it;
// 6. the header, every entry and one metadata-only audit are appended atomically; the database guards re-check
//    every link and, at commit, the completeness, order, counts and manifest digest.
// Nothing is adjudicated, sent, paid, settled, posted or rewritten.

class CaseRefusal extends Error {
  readonly code: CaseErrorCode
  constructor(code: CaseErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: CaseErrorCode, message: string): never {
  throw new CaseRefusal(code, message)
}

const invalid = (message: string): CaseResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const notFound = (): CaseResult<never> => ({ ok: false, code: 'NOT_FOUND', message: 'claim submission not found' })

const MAX_CASE_ATTEMPTS = 3
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

// The database guards (including the commit-time completeness check) are the backstop behind every service check.
const databaseGuardMarkers = [
  'evidence_case_snapshot_time',
  'evidence_case_snapshot_coherence',
  'evidence_case_snapshot_incomplete',
  'evidence_case_snapshot_manifest',
  'evidence_case_entry_late',
  'evidence_case_entry_linkage',
  'evidence_case_entry_derivation',
  'evidence_case_entry_conflict',
  'evidence_case_snapshots is append-only',
  'evidence_case_entries is append-only',
]

// A lost connection or transaction leaves the outcome unknown: never re-inserted, the caller re-reads.
const isUnknownOutcome = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2028'].includes(error.code)) ||
  (error instanceof Error && /Connection terminated|ECONNRESET|server closed the connection|Transaction already closed|Transaction API error/i.test(error.message))

// ---- DTO ---------------------------------------------------------------------------------------------

function toHeaderDto(record: CaseHeaderRecord): CaseHeaderDto {
  return {
    caseId: record.id,
    claimSubmissionId: record.claimSubmissionId,
    contractVersion: record.contractVersion,
    assemblyCode: record.assemblyCode as AssemblyCode,
    sourceCount: record.sourceCount,
    classifiedCount: record.classifiedCount,
    readinessCount: record.readinessCount,
    itemCount: record.itemCount,
    manifestSha256: record.manifestSha256,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt.toISOString(),
  }
}

function toCaseDto(record: CaseRecord): CaseDto {
  return {
    ...toHeaderDto(record),
    items: record.entries.map((entry) => ({
      ordinal: entry.ordinal,
      sourceEvidenceId: entry.sourceEvidenceId,
      classificationId: entry.classificationId,
      readinessId: entry.readinessId,
      itemReasonCode: entry.itemReasonCode as ItemReasonCode,
    })),
  }
}

// ---- assemble (§7, POST revenue-evidence-cases) ----------------------------------------------------------

async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

async function readFreezeThroughOwner(claimId: string, submissionId: string, tx: DbClient) {
  try {
    return await getFrozenSubmission(claimId, submissionId, tx)
  } catch (error) {
    if (error instanceof Error && /do not match their stored digests/.test(error.message))
      return refuse('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', 'the frozen submission no longer matches its stored digests; nothing was recorded')
    throw error
  }
}

// §7 — each source's classifications and each classification's readiness results, through their owners, on tx.
async function readLinksThroughOwners(submissionId: string, tx: DbClient): Promise<SourceLinks[]> {
  const sources = await getRevenueSourceEvidenceOf(submissionId, tx)
  if (!sources.ok) return refuse('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', 'the frozen submission\'s sources could not be read from their owner; nothing was recorded')
  const links: SourceLinks[] = []
  for (const source of sources.value.items) {
    if (source.claimSubmissionId !== submissionId) return refuse('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', 'a source belongs to another frozen submission; nothing was recorded')
    const classifications = await getClassificationsOf(source.revenueSourceEvidenceId, tx)
    if (!classifications.ok) return refuse('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', 'a source\'s classifications could not be read from their owner; nothing was recorded')
    const readiness = []
    for (const classification of classifications.value.items) {
      const results = await getReadinessOf(classification.classificationId, tx)
      if (!results.ok) return refuse('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', 'a classification\'s readiness could not be read from its owner; nothing was recorded')
      readiness.push(...results.value.items)
    }
    links.push({ sourceEvidenceId: source.revenueSourceEvidenceId, classifications: classifications.value.items, readiness })
  }
  return links
}

async function assembleOnTransaction(owner: { claimId: string; organizationId: string }, submissionId: string, actorUserId: string, tx: DbClient): Promise<CaseOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', owner.claimId))) return refuse('NOT_FOUND', 'claim submission not found')
  await concurrencyProbe('evidenceCase.claim_locked')

  // 3 — the frozen submission, verified by its owner under the lock, then every link through its owner.
  const frozen = await readFreezeThroughOwner(owner.claimId, submissionId, tx)
  if (!frozen) return refuse('NOT_FOUND', 'claim submission not found')

  // 4 — the one pure assembler, from the owners' stored facts; a broken link refuses even a replay (fail closed).
  const links = await readLinksThroughOwners(submissionId, tx)
  const assembled = assembleCase({ claimSubmissionId: submissionId, organizationId: owner.organizationId, sources: links })
  if (!assembled.ok) return refuse('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', `${assembled.detail}; nothing was recorded`)
  const value = assembled.value

  // 5 — the same identity already recorded is the idempotent answer, exactly as recorded: a case is history, and a
  // source registered after it never mutates it.
  const existing = await findCaseByIdentity(submissionId, CASE_CONTRACT_VERSION, tx)
  if (existing) return { replayed: true, case: toCaseDto(existing) }

  // 6 — one header, every entry and one business audit, atomically; the database checks completeness at commit.
  const caseId = await insertCaseHeader(
    {
      organizationId: owner.organizationId,
      claimSubmissionId: submissionId,
      contractVersion: CASE_CONTRACT_VERSION,
      assemblyCode: value.assemblyCode,
      sourceCount: value.sourceCount,
      classifiedCount: value.classifiedCount,
      readinessCount: value.readinessCount,
      itemCount: value.itemCount,
      manifestSha256: value.manifestSha256,
      recordedByUserId: actorUserId,
    },
    tx,
  )
  await concurrencyProbe('evidenceCase.header_inserted')
  await insertCaseEntries(caseId, value.items, tx)
  await concurrencyProbe('evidenceCase.entries_inserted')
  const recorded = await findCaseById(caseId, tx)
  if (!recorded) return refuse('REVENUE_EVIDENCE_CASE_CONFLICT', 'the case could not be read back; nothing was recorded')
  // §6 — metadata only: ids, contract, the controlled code, counts, digest and time. No PHI, payer value or bytes.
  await recordAuditEvent(
    {
      organizationId: owner.organizationId,
      actorUserId,
      actionCode: 'revenue_evidence_case.assembled',
      entityType: 'REVENUE_EVIDENCE_CASE',
      entityId: caseId,
      beforeState: null,
      afterState: {
        caseId,
        claimSubmissionId: submissionId,
        contractVersion: recorded.contractVersion,
        assemblyCode: recorded.assemblyCode,
        sourceCount: recorded.sourceCount,
        classifiedCount: recorded.classifiedCount,
        readinessCount: recorded.readinessCount,
        itemCount: recorded.itemCount,
        manifestSha256: recorded.manifestSha256,
        recordedAt: recorded.recordedAt.toISOString(),
      },
    },
    tx,
  )
  await concurrencyProbe('evidenceCase.audited')
  return { replayed: false, case: toCaseDto(recorded) }
}

export async function assembleRevenueEvidenceCase(submissionId: string, body: unknown, actorUserId: string): Promise<CaseResult<CaseOutcome>> {
  if (!isCaseUuid(submissionId)) return invalid('invalid claim submission id')
  const validated = validateCaseBody(body)
  if (!validated.ok) return invalid(validated.message)
  const id = submissionId.toLowerCase()
  // The submission's Claim and organization never change (the freeze is immutable), so they are read before the
  // lock for routing only and verified again under it by the A6.7 owner.
  const located = await findSubmissionForRevenueEvidence(id, prisma)
  if (!located) return notFound()
  const owner = { claimId: located.claimId, organizationId: located.organizationId }

  const waitingSince = Date.now()
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => assembleOnTransaction(owner, id, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof CaseRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        if (Date.now() - waitingSince > LOCK_WAIT_BUDGET_MS) return { ok: false, code: 'REVENUE_EVIDENCE_CASE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was recorded' }
        await waitForClaimLock(owner.claimId)
        await pauseAfterLockWait()
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_CASE_ATTEMPTS) continue
        return { ok: false, code: 'REVENUE_EVIDENCE_CASE_CONFLICT', message: 'concurrent case requests for this submission kept conflicting; nothing was recorded' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT', message: 'the database refused the case as inconsistent with its sources; nothing was recorded' }
      if (isUnknownOutcome(error))
        return { ok: false, code: 'REVENUE_EVIDENCE_CASE_CONFLICT', message: 'the outcome could not be established; read the submission\'s cases before requesting again' }
      throw error
    }
  }
}

// ---- reads (§6) ----------------------------------------------------------------------------------------

// A submission's case headers on the CALLER's transaction — what later owners consult. Nothing is written.
export async function getCasesOf(submissionId: string, tx: DbClient): Promise<CaseResult<CaseListDto>> {
  if (!isCaseUuid(submissionId)) return invalid('invalid claim submission id')
  const id = submissionId.toLowerCase()
  if (!(await findSubmissionForRevenueEvidence(id, tx))) return notFound()
  return { ok: true, value: { items: (await findCasesOfSubmission(id, tx)).map(toHeaderDto) } }
}

// The public history read, from one READ ONLY snapshot.
export async function listRevenueEvidenceCases(submissionId: string): Promise<CaseResult<CaseListDto>> {
  if (!isCaseUuid(submissionId)) return invalid('invalid claim submission id')
  return withReadSnapshot(undefined, (tx) => getCasesOf(submissionId, tx))
}

export async function getRevenueEvidenceCase(caseId: string): Promise<CaseResult<CaseDto>> {
  if (!isCaseUuid(caseId)) return invalid('invalid revenue evidence case id')
  const record = await findCaseById(caseId.toLowerCase())
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'revenue evidence case not found' }
  return { ok: true, value: toCaseDto(record) }
}
