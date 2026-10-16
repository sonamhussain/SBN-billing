import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { isLockUnavailable, lockRowForUpdate, lockRowForUpdateNowait } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { moneyText } from '../claim-pricing/claim-pricing.calculator.ts'
// A5.9 owns the readiness, policy and recency decision. A6.4 calls its transaction-aware composer on the
// same snapshot as every other read and never re-implements any part of it.
import { composeA6Handoff } from '../pre-claim-readiness/pre-claim-readiness.service.ts'
import { assemblyFingerprint, evaluateDraft, type DraftSnapshot, type SnapshotHandoff, type SnapshotPricing } from './claim-draft.assembly.ts'
import {
  createAssessmentRecord,
  createFindingRecords,
  findActiveDraftDiagnoses,
  findActiveDraftLines,
  findActiveDraftPointers,
  findAssessmentById,
  findAssessmentsOfClaim,
  findClaimLineage,
  findDraftPricingRun,
} from './claim-draft.repository.ts'
import {
  DRAFT_CONTRACT_VERSION,
  type ClaimDraftDto,
  type ClaimDraftErrorCode,
  type ClaimDraftResult,
  type DraftAssessmentDto,
  type DraftAssessmentListDto,
  type DraftAssessmentSummaryDto,
  type DraftFinding,
  type DraftOutcome,
  type FindingCode,
  type FindingSeverity,
  type OwnerScope,
} from './claim-draft.types.ts'
import { isClaimDraftUuid, validateCreateAssessmentBody, validatePreviewQuery } from './claim-draft.validation.ts'

// A6.4 §4 — the draft is assembled from one snapshot:
// 1. the route has already resolved Claim -> Encounter -> Patient -> Organization and answered another
//    tenant's Claim exactly like a missing one;
// 2. a preview reads in one READ ONLY REPEATABLE READ transaction; an assessment takes the Claim row lock
//    (the same lock every A6.2 structure writer and A6.3 pricing run takes) as the FIRST statement of one
//    SERIALIZABLE transaction, without waiting, so its snapshot never predates a writer it would have waited
//    for; a busy Claim is waited for outside the transaction and the assessment starts again, bounded;
// 3. the A5.9 handoff composer runs on that same transaction; a refusal is recorded as a finding;
// 4. active lines, diagnoses and pointers are read in position order and checked, never repaired;
// 5. the pricing run is the exact one the caller named and must belong to this Claim — never "latest";
// 6. drift is judged against A6.3's captured fingerprints, never by timestamps or by re-pricing;
// 7. only an explicit assessment writes: one assessment, its findings and one audit, atomically.

class DraftRefusal extends Error {
  readonly code: ClaimDraftErrorCode
  constructor(code: ClaimDraftErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function refuse(code: ClaimDraftErrorCode, message: string): never {
  throw new DraftRefusal(code, message)
}

const invalid = (message: string): ClaimDraftResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

const MAX_ASSESSMENT_ATTEMPTS = 3
// Waiting for a busy Claim is not a conflict: the assessment starts again once the writer has finished, a
// bounded number of times.
const MAX_LOCK_WAITS = 5

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer of the same Claim (Prisma: P2034); a deadlock is retried the same way.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || (error instanceof Error && /could not serialize access|40001|deadlock detected/.test(error.message))

// The database guards are the backstop behind every service check.
const databaseGuardMarkers = ['claim_draft_assessment_coherence', 'claim_draft_finding_scope', 'claim_draft_assessments_complete', 'claim_draft_findings:']

// ---- the snapshot ------------------------------------------------------------------------------------

type Assembled = { snapshot: DraftSnapshot; organizationId: string; handoffRefusal: string | null }

async function assemble(claimId: string, pricingRunId: string | null, tx: DbClient): Promise<Assembled> {
  const claim = await findClaimLineage(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', 'claim not found')
  const run = claim.preClaimReadinessAssessment.validationRun

  const composed = await composeA6Handoff(claim.preClaimReadinessAssessmentId, tx)
  const handoff: SnapshotHandoff = composed.ok
    ? {
        ok: true,
        schemaVersion: composed.value.schemaVersion,
        readinessAssessmentId: composed.value.readinessAssessmentId,
        encounterId: composed.value.validationRun.encounterId,
        encounterActivityIds: new Set(composed.value.exactReferences.encounterActivityIds),
        encounterDiagnosisIds: new Set(composed.value.exactReferences.encounterDiagnosisIds),
      }
    : { ok: false, refusal: composed.code }

  // §4 step 5 — the exact run the caller named. A run of another Claim (of this or any organization) is
  // answered exactly like a missing one, so nothing about it is disclosed and nothing is substituted.
  let pricing: SnapshotPricing | null = null
  if (pricingRunId !== null) {
    const stored = await findDraftPricingRun(pricingRunId, tx)
    if (!stored || stored.claimId !== claimId) return refuse('NOT_FOUND', 'pricing run not found')
    pricing = {
      id: stored.id,
      claimId: stored.claimId,
      pricingContractVersion: stored.pricingContractVersion,
      providerContractId: stored.providerContractId,
      tariffScheduleId: stored.tariffScheduleId,
      tariffScheduleVersionId: stored.tariffScheduleVersionId,
      overallResult: stored.overallResult,
      lineCount: stored.lineCount,
      pricedCount: stored.pricedCount,
      currencyCode: stored.currencyCode,
      totalExtendedAmount: stored.totalExtendedAmount,
      inputStructureFingerprint: stored.inputStructureFingerprint,
      lines: stored.lineResults.map((line) => ({
        id: line.id,
        claimLineId: line.claimLineId,
        encounterActivityId: line.encounterActivityId,
        lineSequenceAtEvaluation: line.lineSequenceAtEvaluation,
        outcome: line.outcome,
        tariffRateId: line.tariffRateId,
        unitTariffAmount: line.unitTariffAmount,
        quantityAtEvaluation: line.quantityAtEvaluation,
        extendedAmount: line.extendedAmount,
        currencyCode: line.currencyCode,
        inputFingerprint: line.inputFingerprint,
      })),
    }
  }

  const lines = await findActiveDraftLines(claimId, tx)
  const diagnoses = await findActiveDraftDiagnoses(claimId, tx)
  const pointers = await findActiveDraftPointers(claimId, tx)

  return {
    organizationId: claim.encounter.patient.organizationId,
    handoffRefusal: composed.ok ? null : composed.code,
    snapshot: {
      lineage: {
        claimId: claim.id,
        claimContractVersion: claim.claimContractVersion,
        handoffSchemaVersion: claim.handoffSchemaVersion,
        readinessAssessmentId: claim.preClaimReadinessAssessmentId,
        validationRunId: run.id,
        serviceDate: run.serviceDate.toISOString().slice(0, 10),
        facilityRegulatoryProfileId: run.facilityRegulatoryProfileId,
        providerContractId: run.providerContractId,
        tariffScheduleId: run.tariffScheduleId,
        tariffScheduleVersionId: run.tariffScheduleVersionId,
      },
      claimEncounterId: claim.encounterId,
      handoff,
      lines: lines.map((line) => ({
        id: line.id,
        sequence: line.sequence,
        sources: line.sources.map(({ encounterActivity: activity }) => ({
          encounterActivityId: activity.id,
          encounterId: activity.encounterId,
          serviceId: activity.serviceId,
          procedureCodeId: activity.procedureCodeId,
          quantity: activity.quantity,
          unitCode: activity.unitCode,
          modifierCodes: activity.modifiers.map((modifier) => modifier.code),
          removed: activity.removedAt !== null,
        })),
      })),
      diagnoses: diagnoses.map((diagnosis) => ({
        id: diagnosis.id,
        sequence: diagnosis.sequence,
        encounterDiagnosisId: diagnosis.encounterDiagnosisId,
        roleCode: diagnosis.roleCode,
        sourceEncounterId: diagnosis.encounterDiagnosis.encounterId,
        sourceRemoved: diagnosis.encounterDiagnosis.removedAt !== null,
      })),
      pointers: pointers.map((pointer) => ({
        id: pointer.id,
        claimLineId: pointer.claimLineId,
        claimDiagnosisId: pointer.claimDiagnosisId,
        diagnosisClaimId: pointer.claimDiagnosis.claimId,
        diagnosisRemoved: pointer.claimDiagnosis.removedAt !== null,
      })),
      pricing,
    },
  }
}

const transactionTime = async (tx: DbClient) => (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now

// ---- the owner's currentness composer (consumed by A6.5) -------------------------------------------

export type CurrentDraft = { organizationId: string; outcome: DraftOutcome; assemblyFingerprint: string; handoffRefusal: string | null }

// The exact draft of a Claim against an exact pricing run, assembled and reduced by this owner on the
// CALLER's transaction, so a consumer judges currentness on the same snapshot as its own reads and writes.
// It is the same assembly, reduction and fingerprint an assessment records; it writes nothing.
export async function composeCurrentDraft(claimId: string, pricingRunId: string, tx: DbClient): Promise<ClaimDraftResult<CurrentDraft>> {
  try {
    const assembled = await assemble(claimId, pricingRunId, tx)
    return {
      ok: true,
      value: {
        organizationId: assembled.organizationId,
        outcome: evaluateDraft(assembled.snapshot).outcome,
        assemblyFingerprint: assemblyFingerprint(assembled.snapshot),
        handoffRefusal: assembled.handoffRefusal,
      },
    }
  } catch (error) {
    if (error instanceof DraftRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- DTOs --------------------------------------------------------------------------------------------

function toDraftDto(assembled: Assembled, evaluatedAt: Date): ClaimDraftDto {
  const { snapshot } = assembled
  const { outcome, findings } = evaluateDraft(snapshot)
  const diagnosisSequence = new Map(snapshot.diagnoses.map((diagnosis) => [diagnosis.id, diagnosis.sequence]))
  const pointersOf = (lineId: string) =>
    snapshot.pointers
      .filter((pointer) => pointer.claimLineId === lineId)
      .map((pointer) => pointer.claimDiagnosisId)
      .sort((a, b) => (diagnosisSequence.get(a) ?? Number.MAX_SAFE_INTEGER) - (diagnosisSequence.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
  const { pricing } = snapshot
  return {
    draftContractVersion: DRAFT_CONTRACT_VERSION,
    outcome,
    assemblyFingerprint: assemblyFingerprint(snapshot),
    lineage: snapshot.lineage,
    handoffRefusal: assembled.handoffRefusal,
    lines: snapshot.lines.map((line) => {
      const source = line.sources.length === 1 ? line.sources[0] : null
      return {
        claimLineId: line.id,
        sequence: line.sequence,
        encounterActivityId: source?.encounterActivityId ?? null,
        serviceId: source?.serviceId ?? null,
        procedureCodeId: source?.procedureCodeId ?? null,
        quantity: source ? source.quantity.toFixed() : null,
        unitCode: source?.unitCode ?? null,
        modifierCodes: source?.modifierCodes ?? [],
        sourceRemoved: source?.removed ?? false,
        claimDiagnosisIds: pointersOf(line.id),
      }
    }),
    diagnoses: snapshot.diagnoses.map((diagnosis) => ({
      claimDiagnosisId: diagnosis.id,
      sequence: diagnosis.sequence,
      encounterDiagnosisId: diagnosis.encounterDiagnosisId,
      roleCode: diagnosis.roleCode,
    })),
    pricing:
      pricing === null
        ? null
        : {
            pricingRunId: pricing.id,
            pricingContractVersion: pricing.pricingContractVersion,
            inputStructureFingerprint: pricing.inputStructureFingerprint,
            overallResult: pricing.overallResult,
            lineCount: pricing.lineCount,
            pricedCount: pricing.pricedCount,
            currencyCode: pricing.currencyCode,
            // Displayed exactly as stored at the currency's minor units; never recomputed.
            totalExtendedTariffAmount: pricing.overallResult === 'PRICED' ? moneyText(pricing.totalExtendedAmount, pricing.currencyCode) : null,
            lines: pricing.lines.map((line) => ({
              claimLineId: line.claimLineId,
              lineSequenceAtEvaluation: line.lineSequenceAtEvaluation,
              outcome: line.outcome,
              extendedTariffAmount: moneyText(line.extendedAmount, line.currencyCode),
            })),
          },
    findings,
    evaluatedAt: evaluatedAt.toISOString(),
  }
}

type AssessmentRecord = NonNullable<Awaited<ReturnType<typeof findAssessmentById>>>
type AssessmentSummaryRecord = Omit<AssessmentRecord, 'findings'>

function toSummaryDto(record: AssessmentSummaryRecord): DraftAssessmentSummaryDto {
  return {
    id: record.id,
    claimId: record.claimId,
    pricingRunId: record.pricingRunId,
    draftContractVersion: record.draftContractVersion,
    handoffAssessmentId: record.handoffAssessmentId,
    outcome: record.outcome,
    assemblyFingerprint: record.assemblyFingerprint,
    pricingInputFingerprint: record.pricingInputFingerprint,
    activeLineCount: record.activeLineCount,
    activeDiagnosisCount: record.activeDiagnosisCount,
    findingCount: record.findingCount,
    evaluatedAt: record.evaluatedAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

function toAssessmentDto(record: AssessmentRecord): DraftAssessmentDto {
  return {
    ...toSummaryDto(record),
    findings: record.findings.map(
      (finding): DraftFinding => ({
        ordinal: finding.ordinal,
        findingCode: finding.findingCode as FindingCode,
        severity: finding.severity as FindingSeverity,
        ownerScope: finding.ownerScope as OwnerScope,
        relatedClaimLineId: finding.relatedClaimLineId,
        relatedClaimDiagnosisId: finding.relatedClaimDiagnosisId,
      }),
    ),
  }
}

// ---- preview (§9 GET draft) ----------------------------------------------------------------------

export async function previewClaimDraft(claimId: string, query: unknown): Promise<ClaimDraftResult<ClaimDraftDto>> {
  if (!isClaimDraftUuid(claimId)) return invalid('invalid claim id')
  const validated = validatePreviewQuery(query)
  if (!validated.ok) return invalid(validated.message)
  try {
    // One READ ONLY snapshot: Postgres itself refuses any write, so a preview can never persist anything.
    return await withReadSnapshot(undefined, async (tx) => {
      const assembled = await assemble(claimId, validated.value.pricingRunId, tx)
      return { ok: true as const, value: toDraftDto(assembled, await transactionTime(tx)) }
    })
  } catch (error) {
    if (error instanceof DraftRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- assessment (§9 POST draft-assessments) --------------------------------------------------------

// Waits, outside any assessment transaction, until the current holder of the Claim lock has finished. The
// lock is released at once; it only orders this assessment after that writer.
async function waitForClaimLock(claimId: string) {
  await prisma.$transaction(async (tx) => lockRowForUpdate(tx, 'claims', claimId), { maxWait: 10_000, timeout: 60_000 })
}

export async function createDraftAssessment(claimId: string, body: unknown, actorUserId: string): Promise<ClaimDraftResult<DraftAssessmentDto>> {
  if (!isClaimDraftUuid(claimId)) return invalid('invalid claim id')
  const validated = validateCreateAssessmentBody(body)
  if (!validated.ok) return invalid(validated.message)

  let lockWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const value = await prisma.$transaction(
        async (tx) => {
          // §10 — the Claim lock is the first statement, before any authoritative read, in the same order
          // as every A6.2 structure writer and A6.3 pricing run, so no line, diagnosis, pointer or pricing
          // change of this Claim can interleave with the assessment or be missing from its snapshot.
          if (!(await lockRowForUpdateNowait(tx, 'claims', claimId))) return refuse('NOT_FOUND', 'claim not found')
          await concurrencyProbe('claimDraft.claim_locked')
          const assembled = await assemble(claimId, validated.value.pricingRunId, tx)
          const { snapshot } = assembled
          const pricing = snapshot.pricing as SnapshotPricing
          const { outcome, findings } = evaluateDraft(snapshot)
          const evaluatedAt = await transactionTime(tx)

          const assessment = await createAssessmentRecord(
            {
              claimId,
              pricingRunId: pricing.id,
              draftContractVersion: DRAFT_CONTRACT_VERSION,
              handoffAssessmentId: snapshot.lineage.readinessAssessmentId,
              outcome,
              assemblyFingerprint: assemblyFingerprint(snapshot),
              pricingInputFingerprint: pricing.inputStructureFingerprint,
              activeLineCount: snapshot.lines.length,
              activeDiagnosisCount: snapshot.diagnoses.length,
              findingCount: findings.length,
              evaluatedAt,
              createdByUserId: actorUserId,
            },
            tx,
          )
          await createFindingRecords(
            findings.map((finding) => ({
              draftAssessmentId: assessment.id,
              ordinal: finding.ordinal,
              findingCode: finding.findingCode,
              severity: finding.severity,
              ownerScope: finding.ownerScope,
              relatedClaimLineId: finding.relatedClaimLineId,
              relatedClaimDiagnosisId: finding.relatedClaimDiagnosisId,
            })),
            tx,
          )
          await concurrencyProbe('claimDraft.inserted')
          // §10 — metadata only: no line, tariff, amount, diagnosis, patient or evidence value.
          await recordAuditEvent(
            {
              organizationId: assembled.organizationId,
              actorUserId,
              actionCode: 'claim_draft.assessed',
              entityType: 'CLAIM_DRAFT_ASSESSMENT',
              entityId: assessment.id,
              beforeState: null,
              afterState: {
                id: assessment.id,
                claimId,
                pricingRunId: pricing.id,
                draftContractVersion: DRAFT_CONTRACT_VERSION,
                outcome,
                findingCount: findings.length,
                evaluatedAt: evaluatedAt.toISOString(),
              },
            },
            tx,
          )
          await concurrencyProbe('claimDraft.audited')
          const stored = await findAssessmentById(assessment.id, tx)
          if (!stored) return refuse('CLAIM_DRAFT_INTEGRITY_CONFLICT', 'the assessment could not be read back')
          return toAssessmentDto(stored)
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000 },
      )
      return { ok: true, value }
    } catch (error) {
      if (error instanceof DraftRefusal) return { ok: false, code: error.code, message: error.message }
      if (isLockUnavailable(error)) {
        lockWaits += 1
        if (lockWaits > MAX_LOCK_WAITS) return { ok: false, code: 'CLAIM_DRAFT_WRITE_CONFLICT', message: 'the claim stayed busy with other changes; nothing was written' }
        await waitForClaimLock(claimId)
        continue
      }
      if (isWriteConflict(error)) {
        attempt += 1
        if (attempt <= MAX_ASSESSMENT_ATTEMPTS) continue
        return { ok: false, code: 'CLAIM_DRAFT_WRITE_CONFLICT', message: 'concurrent changes to this claim kept conflicting with the assessment; nothing was written' }
      }
      if (error instanceof Error && databaseGuardMarkers.some((marker) => error.message.includes(marker)))
        return { ok: false, code: 'CLAIM_DRAFT_INTEGRITY_CONFLICT', message: 'the database refused the claim draft assessment; nothing was written' }
      throw error
    }
  }
}

// ---- reads (§9) --------------------------------------------------------------------------------------

export async function listDraftAssessments(claimId: string): Promise<ClaimDraftResult<DraftAssessmentListDto>> {
  if (!isClaimDraftUuid(claimId)) return invalid('invalid claim id')
  if (!(await findClaimLineage(claimId, prisma))) return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
  return { ok: true, value: { items: (await findAssessmentsOfClaim(claimId)).map(toSummaryDto) } }
}

export async function getDraftAssessment(id: string): Promise<ClaimDraftResult<DraftAssessmentDto>> {
  if (!isClaimDraftUuid(id)) return invalid('invalid claim draft assessment id')
  const record = await findAssessmentById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'claim draft assessment not found' }
  return { ok: true, value: toAssessmentDto(record) }
}
