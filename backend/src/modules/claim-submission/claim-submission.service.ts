import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The owners A6.7 consumes, each called on THIS transaction so every fact comes from one locked snapshot:
// A6.5 owns the current review authority, A6.6 the canonical bytes (and through it A5.9, A6.4 and A6.3).
// None of their logic is re-implemented here.
import { getCurrentReviewAuthority } from '../claim-review/claim-review.service.ts'
import { composeCanonicalClaimPayload } from '../claim-payload/claim-payload.composer.ts'
import { PAYLOAD_SCHEMA_VERSION } from '../claim-payload/claim-payload.types.ts'
import { packageSealSha256, sha256Hex } from '../claim-evidence/claim-evidence.hash.ts'
import { buildEvidenceManifest, encodeEvidenceManifest, evidenceReferencesFromPayload, EvidenceIncompleteError, ManifestEncodingError } from '../claim-evidence/claim-evidence.manifest.ts'
import { EVIDENCE_MANIFEST_VERSION, type EvidenceManifestV1 } from '../claim-evidence/claim-evidence.types.ts'
import {
  findAssessmentForFreeze,
  findClaimForFreeze,
  findFreezeByApproval,
  findFreezeById,
  findFreezesOfClaim,
  findReviewEventForFreeze,
  insertEvidenceEntries,
  insertEvidencePackage,
  insertFreeze,
  readOwnerVersionFacts,
  type FreezeRecord,
} from './claim-submission.repository.ts'
import {
  SUBMISSION_CONTRACT_VERSION,
  type ClaimSubmissionDto,
  type ClaimSubmissionErrorCode,
  type ClaimSubmissionListDto,
  type ClaimSubmissionResult,
  type EvidenceManifestDto,
  type FreezeOutcome,
  type FrozenSubmission,
} from './claim-submission.types.ts'
import { isClaimSubmissionUuid, validateFreezeBody } from './claim-submission.validation.ts'

// A6.7 §5 — a freeze is written in one SERIALIZABLE transaction:
// 1. the route has already resolved Claim -> Encounter -> Patient -> Organization, answered another
//    tenant's Claim exactly like a missing one, and checked the actor's permission;
// 2. the Claim row lock is the FIRST statement, without waiting (the same lock every A6.2–A6.5 writer
//    takes), so the snapshot never predates a writer it would have waited for; a busy Claim is waited for
//    outside the transaction and the freeze starts again on a fresh snapshot;
// 3. under the lock, an existing freeze of the exact approval is the idempotent answer: same lineage ->
//    the same frozen metadata with no write; different lineage -> refused;
// 4. the exact assessment and APPROVE of this Claim, and the A6.5 authority on the same snapshot: only
//    APPROVED_CURRENT for exactly that event, assessment and fingerprint;
// 5. the A6.6 composer on this same transaction (never the preview, never a second snapshot);
// 6. the A6-EVIDENCE-1 manifest from exactly that payload and the owners' version facts;
// 7. the freeze, its package, its ordered entries and one metadata-only audit, atomically; the database
//    recomputes every digest and the seal, guards the lineage and checks completeness at commit.
// Nothing is sent, queued, given a lifecycle state or an external identifier.

class FreezeRefusal extends Error {
  readonly code: ClaimSubmissionErrorCode
  constructor(code: ClaimSubmissionErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClaimSubmissionErrorCode, message: string): never {
  throw new FreezeRefusal(code, message)
}

const invalid = (message: string): ClaimSubmissionResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_FREEZE_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the freeze starts again once the writer has finished, a
// bounded number of times.
const MAX_LOCK_WAITS = 5

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer (Prisma: P2034); a deadlock is retried the same way.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// One freeze per approval: a colliding insert means another freeze of that approval committed first. The
// freeze starts again and re-reads it (the idempotent answer), never creating a second one.
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = [
  'claim_freeze_time',
  'claim_freeze_coherence',
  'claim_freeze_digest',
  'claim_freeze_evidence_time',
  'claim_freeze_evidence_coherence',
  'claim_freeze_evidence_digest',
  'claim_freeze_evidence_incomplete',
  'is append-only',
]

// ---- DTOs --------------------------------------------------------------------------------------------

function toSubmissionDto(record: FreezeRecord): ClaimSubmissionDto {
  const evidence = record.evidenceManifest
  if (!evidence) return refuse('CLAIM_SUBMISSION_CONFLICT', 'a frozen submission has no evidence package')
  return {
    submissionId: record.id,
    claimId: record.claimId,
    draftAssessmentId: record.draftAssessmentId,
    approvalDecisionId: record.approvalReviewEventId,
    pricingRunId: record.pricingRunId,
    submissionContractVersion: record.submissionContractVersion,
    payloadSchemaVersion: record.payloadSchemaVersion,
    approvedAssemblyFingerprint: record.approvedAssemblyFingerprint,
    payloadSha256: record.payloadSha256,
    payloadByteLength: record.canonicalPayloadBytes.length,
    frozenAt: record.frozenAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    evidencePackage: {
      evidencePackageId: evidence.id,
      manifestContractVersion: evidence.manifestContractVersion,
      entryCount: evidence.entryCount,
      manifestSha256: evidence.manifestSha256,
      packageSealSha256: evidence.packageSealSha256,
      createdAt: evidence.createdAt.toISOString(),
    },
  }
}

// The stored bytes still hash to their stored digests (they are append-only, so a difference is an
// integrity contradiction, never something to repair).
function verifyStoredDigests(record: FreezeRecord) {
  const evidence = record.evidenceManifest
  if (!evidence || sha256Hex(record.canonicalPayloadBytes) !== record.payloadSha256 || sha256Hex(evidence.manifestBytes) !== evidence.manifestSha256)
    refuse('CLAIM_SUBMISSION_CONFLICT', 'the frozen bytes do not match their stored digests')
}

// ---- freeze (§5, POST submissions) ----------------------------------------------------------------------

// Waits, outside any freeze transaction, until the current holder of the Claim lock has finished. The lock
// is released at once; it only orders this freeze after that writer.
async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

const composeRefusal = {
  NOT_AUTHORIZED: 'CLAIM_SUBMISSION_NOT_APPROVED',
  STALE: 'CLAIM_SUBMISSION_STALE',
  INCOMPLETE: 'CLAIM_SUBMISSION_EVIDENCE_INCOMPLETE',
  UNSUPPORTED: 'CLAIM_SUBMISSION_UNSUPPORTED',
  INTEGRITY_CONFLICT: 'CLAIM_SUBMISSION_CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const satisfies Record<string, ClaimSubmissionErrorCode>

async function freezeOnTransaction(claimId: string, draftAssessmentId: string, approvalDecisionId: string, actorUserId: string, tx: DbClient): Promise<FreezeOutcome> {
  if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', 'claim not found')
  await concurrencyProbe('claimSubmission.claim_locked')
  const claim = await findClaimForFreeze(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', 'claim not found')

  // 3 — the idempotency key is the approval. Another Claim's approval is answered like a missing one.
  const existing = await findFreezeByApproval(approvalDecisionId, tx)
  if (existing) {
    if (existing.claimId !== claimId) return refuse('NOT_FOUND', 'claim review decision not found')
    if (existing.draftAssessmentId !== draftAssessmentId) return refuse('CLAIM_SUBMISSION_CONFLICT', 'this approval was already frozen for another draft assessment')
    verifyStoredDigests(existing)
    return { replayed: true, submission: toSubmissionDto(existing) }
  }

  // 4 — the exact assessment and APPROVE of this Claim, and the current authority on this snapshot.
  const assessment = await findAssessmentForFreeze(draftAssessmentId, tx)
  if (!assessment || assessment.claimId !== claimId) return refuse('NOT_FOUND', 'claim draft assessment not found')
  const decision = await findReviewEventForFreeze(approvalDecisionId, tx)
  if (!decision || decision.claimId !== claimId) return refuse('NOT_FOUND', 'claim review decision not found')
  if (decision.decisionCode !== 'APPROVE') return refuse('CLAIM_SUBMISSION_NOT_APPROVED', `a ${decision.decisionCode} decision is not an approval`)
  if (decision.draftAssessmentId !== assessment.id) return refuse('CLAIM_SUBMISSION_NOT_APPROVED', 'the approval is for another draft assessment')
  const authority = await getCurrentReviewAuthority(claimId, tx)
  if (authority.decisionId === decision.id && authority.state === 'APPROVAL_STALE') return refuse('CLAIM_SUBMISSION_STALE', 'the approved draft is no longer current; a fresh assessment and human review are required')
  if (
    authority.state !== 'APPROVED_CURRENT' ||
    authority.decisionId !== decision.id ||
    authority.draftAssessmentId !== assessment.id ||
    authority.fingerprint !== assessment.assemblyFingerprint ||
    decision.approvalFingerprint !== assessment.assemblyFingerprint
  )
    return refuse('CLAIM_SUBMISSION_NOT_APPROVED', 'the approval is not the claim\'s current review authority')

  // 5 — the exact canonical bytes, composed on this transaction.
  const composed = await composeCanonicalClaimPayload(claimId, assessment.id, decision.id, tx)
  if (!composed.ok) return refuse(composeRefusal[composed.outcome], `the canonical payload could not be composed (${composed.message})`)
  const header = composed.payload.header
  if (
    composed.organizationId !== claim.organizationId ||
    header.claimId !== claimId ||
    header.draftAssessmentId !== assessment.id ||
    header.approvalDecisionId !== decision.id ||
    header.pricingRunId !== assessment.pricingRunId ||
    header.draftFingerprint !== assessment.assemblyFingerprint ||
    composed.payload.schemaVersion !== PAYLOAD_SCHEMA_VERSION ||
    sha256Hex(composed.bytes) !== composed.sha256
  )
    return refuse('CLAIM_SUBMISSION_CONFLICT', 'the composed payload does not carry the requested lineage')

  // 6 — the evidence manifest of exactly that payload.
  const identity = { claimId, draftAssessmentId: assessment.id, approvalReviewEventId: decision.id, pricingRunId: assessment.pricingRunId }
  let manifest: EvidenceManifestV1
  try {
    manifest = buildEvidenceManifest(identity, composed.sha256, evidenceReferencesFromPayload(composed.payload, await readOwnerVersionFacts(composed.payload.evidence, tx)))
  } catch (error) {
    if (error instanceof EvidenceIncompleteError) return refuse('CLAIM_SUBMISSION_EVIDENCE_INCOMPLETE', error.message)
    throw error
  }
  const encoded = encodeEvidenceManifest(manifest)
  const seal = packageSealSha256(composed.sha256, encoded.sha256, identity)

  // 7 — the three append-only writes and one business audit, atomically.
  const freezeId = await insertFreeze(
    {
      ...identity,
      submissionContractVersion: SUBMISSION_CONTRACT_VERSION,
      payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
      approvedAssemblyFingerprint: assessment.assemblyFingerprint,
      canonicalPayloadBytes: composed.bytes,
      payloadSha256: composed.sha256,
      createdByUserId: actorUserId,
    },
    tx,
  )
  await concurrencyProbe('claimSubmission.submission_written')
  const packageId = await insertEvidencePackage(
    { freezeId, manifestContractVersion: EVIDENCE_MANIFEST_VERSION, entryCount: manifest.entries.length, manifestBytes: encoded.bytes, manifestSha256: encoded.sha256, packageSealSha256: seal },
    tx,
  )
  await concurrencyProbe('claimSubmission.package_written')
  const written = await insertEvidenceEntries(packageId, manifest.entries, tx)
  if (written !== manifest.entries.length) return refuse('CLAIM_SUBMISSION_CONFLICT', 'the evidence entries were not all written')
  await concurrencyProbe('claimSubmission.entry_written')
  // §7 — metadata only: ids, versions, counts, the byte length and the payload digest. No raw bytes,
  // patient, diagnosis, code text, amount or evidence content.
  await recordAuditEvent(
    {
      organizationId: claim.organizationId,
      actorUserId,
      actionCode: 'claim_submission.frozen',
      entityType: 'CLAIM_SUBMISSION',
      entityId: freezeId,
      beforeState: null,
      afterState: {
        submissionId: freezeId,
        claimId,
        draftAssessmentId: assessment.id,
        approvalDecisionId: decision.id,
        pricingRunId: assessment.pricingRunId,
        submissionContractVersion: SUBMISSION_CONTRACT_VERSION,
        payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
        manifestContractVersion: EVIDENCE_MANIFEST_VERSION,
        entryCount: manifest.entries.length,
        payloadByteLength: composed.bytes.length,
        payloadSha256: composed.sha256,
      },
    },
    tx,
  )
  await concurrencyProbe('claimSubmission.audited')
  const stored = await findFreezeById(freezeId, tx)
  if (!stored) return refuse('CLAIM_SUBMISSION_CONFLICT', 'the frozen submission could not be read back')
  return { replayed: false, submission: toSubmissionDto(stored) }
}

export async function freezeClaimSubmission(claimId: string, body: unknown, actorUserId: string): Promise<ClaimSubmissionResult<FreezeOutcome>> {
  if (!isClaimSubmissionUuid(claimId)) return invalid('invalid claim id')
  const validated = validateFreezeBody(body)
  if (!validated.ok) return invalid(validated.message)
  const { draftAssessmentId, approvalDecisionId } = validated.value
  const id = claimId.toLowerCase()

  let lockWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction((tx) => freezeOnTransaction(id, draftAssessmentId, approvalDecisionId, actorUserId, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof FreezeRefusal) return { ok: false, code: error.code, message: error.message }
      if (error instanceof ManifestEncodingError) return { ok: false, code: 'CLAIM_SUBMISSION_CONFLICT', message: `the evidence manifest could not be encoded exactly (${error.path}); nothing was frozen` }
      if (isLockUnavailable(error)) {
        lockWaits += 1
        if (lockWaits > MAX_LOCK_WAITS) return { ok: false, code: 'CLAIM_SUBMISSION_CONFLICT', message: 'the claim stayed busy with other changes; nothing was frozen' }
        await waitForClaimLock(id)
        continue
      }
      if (isWriteConflict(error) || isUniqueViolation(error)) {
        attempt += 1
        if (attempt <= MAX_FREEZE_ATTEMPTS) continue
        return { ok: false, code: 'CLAIM_SUBMISSION_CONFLICT', message: 'concurrent changes to this claim kept conflicting with the freeze; nothing was frozen' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'CLAIM_SUBMISSION_CONFLICT', message: 'the database refused the freeze as inconsistent with this claim\'s history; nothing was frozen' }
      throw error
    }
  }
}

// ---- reads (§6) ---------------------------------------------------------------------------------------

export async function listClaimSubmissions(claimId: string): Promise<ClaimSubmissionResult<ClaimSubmissionListDto>> {
  if (!isClaimSubmissionUuid(claimId)) return invalid('invalid claim id')
  // One READ ONLY snapshot: the whole history in freeze order, from one committed state.
  const id = claimId.toLowerCase()
  const records = await withReadSnapshot(undefined, async (tx) => ((await findClaimForFreeze(id, tx)) ? findFreezesOfClaim(id, tx) : null))
  if (!records) return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
  return guarded(() => ({ items: records.map(toSubmissionDto) }))
}

async function readFrozen(submissionId: string): Promise<ClaimSubmissionResult<FreezeRecord>> {
  if (!isClaimSubmissionUuid(submissionId)) return invalid('invalid claim submission id')
  const record = await withReadSnapshot(undefined, (tx) => findFreezeById(submissionId.toLowerCase(), tx))
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }
  return { ok: true, value: record }
}

function guarded<T>(build: () => T): ClaimSubmissionResult<T> {
  try {
    return { ok: true, value: build() }
  } catch (error) {
    if (error instanceof FreezeRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

export async function getClaimSubmission(submissionId: string): Promise<ClaimSubmissionResult<ClaimSubmissionDto>> {
  const read = await readFrozen(submissionId)
  if (!read.ok) return read
  return guarded(() => toSubmissionDto(read.value))
}

// The typed manifest exactly as frozen: decoded from the stored bytes after they are checked against their
// stored digest, never rebuilt from today's owner rows.
export async function getEvidenceManifest(submissionId: string): Promise<ClaimSubmissionResult<EvidenceManifestDto>> {
  const read = await readFrozen(submissionId)
  if (!read.ok) return read
  const record = read.value
  return guarded(() => {
    verifyStoredDigests(record)
    const evidence = record.evidenceManifest as NonNullable<FreezeRecord['evidenceManifest']>
    return {
      submissionId: record.id,
      evidencePackageId: evidence.id,
      manifestContractVersion: evidence.manifestContractVersion,
      entryCount: evidence.entryCount,
      manifestSha256: evidence.manifestSha256,
      packageSealSha256: evidence.packageSealSha256,
      manifest: JSON.parse(Buffer.from(evidence.manifestBytes).toString('utf8')) as EvidenceManifestV1,
    }
  })
}

// §6 — the transaction-aware internal read for A6.8/A9: the frozen bytes of one submission of one Claim, on
// the caller's transaction. A submission of another Claim is answered like a missing one.
export async function getFrozenSubmission(claimId: string, submissionId: string, tx: DbClient): Promise<FrozenSubmission | null> {
  if (!isClaimSubmissionUuid(claimId) || !isClaimSubmissionUuid(submissionId)) return null
  const record = await findFreezeById(submissionId.toLowerCase(), tx)
  if (!record || record.claimId !== claimId.toLowerCase() || !record.evidenceManifest) return null
  verifyStoredDigests(record)
  return { submission: toSubmissionDto(record), canonicalPayloadBytes: Buffer.from(record.canonicalPayloadBytes), manifestBytes: Buffer.from(record.evidenceManifest.manifestBytes) }
}
