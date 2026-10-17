import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
// The owners A6.6 composes, each called on the CALLER's transaction so every fact comes from one snapshot:
// A5.9 owns the handoff, A6.4 the draft's currentness and fingerprint, A6.5 the current review authority,
// A6.3 the currency scale. None of their logic is re-implemented here.
import { composeA6Handoff } from '../pre-claim-readiness/pre-claim-readiness.service.ts'
import { composeCurrentDraft } from '../claim-draft/claim-draft.service.ts'
import { getCurrentReviewAuthority } from '../claim-review/claim-review.service.ts'
import { supportedCurrencyMinorUnits } from '../tariff-rate/tariff-rate.types.ts'
import { encodeCanonicalPayload, exactDecimalText, PayloadEncodingError } from './claim-payload.serializer.ts'
import {
  PAYLOAD_SCHEMA_VERSION,
  type CanonicalClaimPayloadV1,
  type CanonicalDiagnosisV1,
  type CanonicalLineV1,
  type ClaimPayloadResult,
  type CanonicalPayloadPreviewDto,
  type ComposeResult,
  type PayloadFailureOutcome,
} from './claim-payload.types.ts'
import { isClaimPayloadUuid, validatePreviewBody } from './claim-payload.validation.ts'

// A6.6 §6 — the read-only composition pipeline, on one transaction:
// 1. the Claim and its exact A5.9 binding; the A5.9 composer refuses a superseded, tied or incompatible
//    handoff;
// 2. the exact A6.4 assessment named by the caller — of this Claim, REVIEWABLE — recomposed by the A6.4
//    owner against its own pricing run: the fingerprint must still be the reviewed one;
// 3. the exact A6.5 APPROVE named by the caller — of this Claim and this assessment — and the A6.5 current
//    authority on the same snapshot: it must be APPROVED_CURRENT for exactly that decision;
// 4. the active A6.2 lines (one source each, modifiers 1..N), diagnoses and pointers and the exact A6.3
//    pricing run, cross-checked for Claim, source, quantity, position, currency and count;
// 5. the bound regulatory profile's jurisdiction (only while ACTIVE, when it is frozen);
// 6. a typed CanonicalClaimPayloadV1, encoded once to UTF-8 bytes with a SHA-256.
// Nothing is written: no row, audit, submission, bytes or hash is persisted. A6.7 calls the same composer
// inside its own guarded write transaction before it freezes anything.

class PayloadRefusal extends Error {
  readonly outcome: PayloadFailureOutcome | 'NOT_FOUND'
  constructor(outcome: PayloadFailureOutcome | 'NOT_FOUND', message: string) {
    super(message)
    this.outcome = outcome
  }
}

function refuse(outcome: PayloadFailureOutcome | 'NOT_FOUND', message: string): never {
  throw new PayloadRefusal(outcome, message)
}

const handoffRefusal: Record<string, PayloadFailureOutcome> = {
  READINESS_SUPERSEDED_BY_NEWER_VALIDATION: 'STALE',
  VALIDATION_RUN_RECENCY_AMBIGUOUS: 'STALE',
  READINESS_POLICY_INCOMPATIBLE: 'STALE',
  PRECLAIM_NOT_READY_FOR_HANDOFF: 'STALE',
}

const sortedUnique = (ids: readonly string[]) => [...new Set(ids)].sort()

async function readClaim(claimId: string, tx: DbClient) {
  return tx.claim.findUnique({
    where: { id: claimId },
    select: { id: true, encounterId: true, preClaimReadinessAssessmentId: true, claimContractVersion: true, handoffSchemaVersion: true, encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
}

async function readActiveLines(claimId: string, tx: DbClient) {
  return tx.claimLine.findMany({
    where: { claimId, removedAt: null },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      sequence: true,
      sources: {
        select: {
          encounterActivity: {
            select: { id: true, encounterId: true, serviceId: true, procedureCodeId: true, quantity: true, unitCode: true, removedAt: true, modifiers: { orderBy: { sequence: 'asc' }, select: { sequence: true, code: true } } },
          },
        },
      },
      diagnosisPointers: { where: { removedAt: null }, select: { claimDiagnosisId: true } },
    },
  })
}

async function readActiveDiagnoses(claimId: string, tx: DbClient) {
  return tx.claimDiagnosis.findMany({
    where: { claimId, removedAt: null },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    select: { id: true, sequence: true, encounterDiagnosisId: true, roleCode: true, encounterDiagnosis: { select: { encounterId: true, diagnosisCodeId: true, removedAt: true } } },
  })
}

// The exported, transaction-aware composer (§7). The caller owns the transaction: a READ ONLY snapshot for
// the preview, A6.7's guarded write transaction later. It never opens a transaction of its own.
export async function composeCanonicalClaimPayload(claimId: string, draftAssessmentId: string, approvalDecisionId: string, tx: DbClient): Promise<ComposeResult> {
  if (![claimId, draftAssessmentId, approvalDecisionId].every(isClaimPayloadUuid)) return { ok: false, outcome: 'VALIDATION_ERROR', message: 'claim, draft assessment and approval decision ids must be UUIDs' }
  try {
    return { ok: true, ...(await compose(claimId.toLowerCase(), draftAssessmentId.toLowerCase(), approvalDecisionId.toLowerCase(), tx)) }
  } catch (error) {
    if (error instanceof PayloadRefusal) return { ok: false, outcome: error.outcome, message: error.message }
    if (error instanceof PayloadEncodingError) return { ok: false, outcome: 'INTEGRITY_CONFLICT', message: `the canonical payload could not be encoded exactly (${error.path})` }
    throw error
  }
}

async function compose(claimId: string, draftAssessmentId: string, approvalDecisionId: string, tx: DbClient) {
  // 1 — the Claim and its exact A5.9 handoff.
  const claim = await readClaim(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', 'claim not found')
  const handoff = await composeA6Handoff(claim.preClaimReadinessAssessmentId, tx)
  if (!handoff.ok) return refuse(handoffRefusal[handoff.code] ?? 'INTEGRITY_CONFLICT', `the bound A5.9 handoff is no longer valid (${handoff.code})`)
  const run = handoff.value.validationRun
  if (run.encounterId !== claim.encounterId || handoff.value.readinessAssessmentId !== claim.preClaimReadinessAssessmentId)
    return refuse('INTEGRITY_CONFLICT', 'the handoff does not belong to this claim')

  // 2 — the exact reviewed A6.4 assessment, still current.
  const assessment = await tx.claimDraftAssessment.findUnique({ where: { id: draftAssessmentId } })
  if (!assessment || assessment.claimId !== claimId) return refuse('NOT_FOUND', 'claim draft assessment not found')
  if (assessment.handoffAssessmentId !== claim.preClaimReadinessAssessmentId) return refuse('INTEGRITY_CONFLICT', 'the assessment is bound to another handoff')
  if (assessment.outcome !== 'REVIEWABLE') return refuse('NOT_AUTHORIZED', `a ${assessment.outcome} draft assessment cannot carry an approval`)
  const current = await composeCurrentDraft(claimId, assessment.pricingRunId, tx)
  if (!current.ok) return refuse('INTEGRITY_CONFLICT', 'the A6.4 owner could not recompose the reviewed draft')
  if (current.value.outcome !== 'REVIEWABLE' || current.value.assemblyFingerprint !== assessment.assemblyFingerprint)
    return refuse('STALE', 'the reviewed draft is no longer current; a fresh assessment and human review are required')

  // 3 — the exact A6.5 APPROVE, and it is the current authority for exactly this assessment.
  const decision = await tx.claimReviewEvent.findUnique({ where: { id: approvalDecisionId } })
  if (!decision || decision.claimId !== claimId) return refuse('NOT_FOUND', 'claim review decision not found')
  if (decision.decisionCode !== 'APPROVE') return refuse('NOT_AUTHORIZED', `a ${decision.decisionCode} decision is not an approval`)
  if (decision.draftAssessmentId !== draftAssessmentId) return refuse('NOT_AUTHORIZED', 'the approval is for another draft assessment')
  if (decision.approvalFingerprint !== assessment.assemblyFingerprint) return refuse('INTEGRITY_CONFLICT', 'the approval fingerprint is not the assessment\'s own')
  const authority = await getCurrentReviewAuthority(claimId, tx)
  if (authority.decisionId !== approvalDecisionId) return refuse('NOT_AUTHORIZED', 'the approval is not the claim\'s current review authority')
  if (authority.state === 'APPROVAL_STALE') return refuse('STALE', 'the approval no longer matches its reviewed draft')
  if (authority.state !== 'APPROVED_CURRENT' || authority.draftAssessmentId !== draftAssessmentId || authority.fingerprint !== assessment.assemblyFingerprint)
    return refuse('NOT_AUTHORIZED', 'the approval does not grant current authority')

  // 4 — the exact A6.3 pricing run and the active A6.2 structure, cross-checked.
  const pricing = await tx.claimPricingRun.findUnique({ where: { id: assessment.pricingRunId }, include: { lineResults: true } })
  if (!pricing || pricing.claimId !== claimId) return refuse('INTEGRITY_CONFLICT', 'the pricing run does not belong to this claim')
  if (pricing.inputStructureFingerprint !== assessment.pricingInputFingerprint) return refuse('INTEGRITY_CONFLICT', 'the pricing run fingerprint is not the one the assessment judged')
  if (pricing.overallResult !== 'PRICED' || pricing.currencyCode === null || pricing.totalExtendedAmount === null) return refuse('INCOMPLETE', 'the pricing run has no priced total')
  const currencyCode = pricing.currencyCode
  const moneyScale = supportedCurrencyMinorUnits[currencyCode]
  if (moneyScale === undefined) return refuse('UNSUPPORTED', `currency ${currencyCode} has no defined minor units`)

  const context = run.context
  if (context.payerId === null || context.providerContractId === null || context.tariffScheduleId === null || context.tariffScheduleVersionId === null)
    return refuse('INCOMPLETE', 'the bound commercial context has no payer, contract or tariff')
  if (pricing.providerContractId !== context.providerContractId || pricing.tariffScheduleId !== context.tariffScheduleId || pricing.tariffScheduleVersionId !== context.tariffScheduleVersionId)
    return refuse('INTEGRITY_CONFLICT', 'the pricing run is not priced under the bound commercial context')

  const lines = await readActiveLines(claimId, tx)
  const diagnoses = await readActiveDiagnoses(claimId, tx)
  if (lines.length === 0 || diagnoses.length === 0) return refuse('INCOMPLETE', 'the claim has no active line or diagnosis')
  if (lines.some((line, index) => line.sequence !== index + 1) || diagnoses.some((diagnosis, index) => diagnosis.sequence !== index + 1))
    return refuse('INTEGRITY_CONFLICT', 'active line or diagnosis positions are not 1..N')
  if (pricing.lineCount !== lines.length || pricing.pricedCount !== lines.length || pricing.lineResults.length !== lines.length)
    return refuse('INTEGRITY_CONFLICT', 'the pricing run does not cover exactly the active lines')

  const diagnosisSequence = new Map(diagnoses.map((diagnosis) => [diagnosis.id, diagnosis.sequence]))
  const canonicalDiagnoses: CanonicalDiagnosisV1[] = diagnoses.map((diagnosis) => {
    if (diagnosis.encounterDiagnosis.encounterId !== claim.encounterId || diagnosis.encounterDiagnosis.removedAt !== null)
      return refuse('INTEGRITY_CONFLICT', 'a diagnosis source is not an active diagnosis of the claim\'s encounter')
    return { claimDiagnosisId: diagnosis.id, sequence: diagnosis.sequence, encounterDiagnosisId: diagnosis.encounterDiagnosisId, roleCode: diagnosis.roleCode, diagnosisCodeId: diagnosis.encounterDiagnosis.diagnosisCodeId }
  })

  const canonicalLines: CanonicalLineV1[] = lines.map((line, index) => {
    const path = `lines[${index}]`
    if (line.sources.length !== 1) return refuse('INTEGRITY_CONFLICT', `${path} does not have exactly one source activity`)
    const activity = line.sources[0].encounterActivity
    if (activity.encounterId !== claim.encounterId || activity.removedAt !== null) return refuse('INTEGRITY_CONFLICT', `${path} source is not an active activity of the claim's encounter`)
    if (activity.modifiers.some((modifier, position) => modifier.sequence !== position + 1)) return refuse('INTEGRITY_CONFLICT', `${path} modifiers are not in positions 1..N`)
    const result = pricing.lineResults.filter((candidate) => candidate.claimLineId === line.id)
    if (result.length !== 1) return refuse('INTEGRITY_CONFLICT', `${path} has no single pricing line result`)
    const priced = result[0]
    if (
      priced.outcome !== 'PRICED' ||
      priced.encounterActivityId !== activity.id ||
      priced.lineSequenceAtEvaluation !== line.sequence ||
      !priced.quantityAtEvaluation.equals(activity.quantity) ||
      priced.currencyCode !== currencyCode ||
      priced.tariffRateId === null ||
      priced.unitTariffAmount === null ||
      priced.extendedAmount === null
    )
      return refuse('INTEGRITY_CONFLICT', `${path} does not agree with its pricing line result`)
    const pointed = line.diagnosisPointers.map((pointer) => pointer.claimDiagnosisId)
    if (pointed.length === 0 || pointed.some((id) => !diagnosisSequence.has(id))) return refuse('INTEGRITY_CONFLICT', `${path} points to no active diagnosis of this claim`)
    return {
      claimLineId: line.id,
      sequence: line.sequence,
      encounterActivityId: activity.id,
      serviceId: activity.serviceId,
      procedureCodeId: activity.procedureCodeId,
      quantity: exactDecimalText(activity.quantity, 4, `${path}.quantity`),
      unitCode: activity.unitCode,
      modifierCodes: activity.modifiers.map((modifier) => modifier.code),
      pricingLineResultId: priced.id,
      tariffRateId: priced.tariffRateId,
      unitTariffAmount: exactDecimalText(priced.unitTariffAmount, 4, `${path}.unitTariffAmount`),
      extendedAmount: exactDecimalText(priced.extendedAmount, moneyScale, `${path}.extendedAmount`),
      currencyCode,
      claimDiagnosisIds: [...pointed].sort((a, b) => (diagnosisSequence.get(a) as number) - (diagnosisSequence.get(b) as number)),
    }
  })

  // 5 — the jurisdiction of the bound regulatory profile, only while it is ACTIVE (and therefore frozen).
  const profile = await tx.facilityRegulatoryProfile.findUnique({ where: { id: context.facilityRegulatoryProfileId }, select: { facilityId: true, jurisdictionCode: true, status: true } })
  if (!profile || profile.facilityId !== context.facilityId) return refuse('INTEGRITY_CONFLICT', 'the bound regulatory profile does not belong to the bound facility')
  if (profile.status !== 'ACTIVE') return refuse('INCOMPLETE', 'the bound regulatory profile is not ACTIVE, so its jurisdiction is not a frozen historical value')

  // 6 — the typed payload, encoded once.
  const references = handoff.value.exactReferences
  const payload: CanonicalClaimPayloadV1 = {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    header: {
      claimId,
      claimContractVersion: claim.claimContractVersion,
      handoffSchemaVersion: claim.handoffSchemaVersion,
      encounterId: claim.encounterId,
      serviceDate: context.serviceDate,
      facilityId: context.facilityId,
      facilityRegulatoryProfileId: context.facilityRegulatoryProfileId,
      jurisdictionCode: profile.jurisdictionCode,
      assessedValidationRunId: run.id,
      readinessAssessmentId: handoff.value.readinessAssessmentId,
      readinessPolicyVersion: handoff.value.readinessPolicyVersion,
      draftAssessmentId,
      draftContractVersion: assessment.draftContractVersion,
      draftFingerprint: assessment.assemblyFingerprint,
      pricingRunId: pricing.id,
      pricingContractVersion: pricing.pricingContractVersion,
      approvalDecisionId,
    },
    commercial: {
      providerContractId: context.providerContractId,
      tariffScheduleId: context.tariffScheduleId,
      tariffScheduleVersionId: context.tariffScheduleVersionId,
      payerId: context.payerId,
      tpaId: context.tpaId,
      networkId: context.networkId,
      insuranceProductId: context.insuranceProductId,
      currencyCode,
    },
    lines: canonicalLines,
    diagnoses: canonicalDiagnoses,
    financial: { totalExtendedAmount: exactDecimalText(pricing.totalExtendedAmount, moneyScale, 'financial.totalExtendedAmount'), currencyCode },
    evidence: {
      validationFindingIds: sortedUnique(handoff.value.findingRefs.map((finding) => finding.id)),
      eligibilityVerificationIds: sortedUnique(references.eligibilityVerificationIds),
      priorAuthorizationVersionIds: sortedUnique(references.priorAuthorizationVersionIds),
      authorizationLineIds: sortedUnique(references.authorizationLineIds),
      evidenceRequirementIds: sortedUnique(references.evidenceRequirementIds),
      evidenceArtifactVersionIds: sortedUnique(references.evidenceArtifactVersionIds),
      ruleVersionIds: sortedUnique(references.ruleVersionIds),
      governingSourceVersionIds: sortedUnique(references.governingSourceVersionIds),
      referenceDatasetVersionIds: sortedUnique(references.referenceDatasetVersionIds),
    },
    approval: {
      reviewContractVersion: decision.reviewContractVersion,
      decisionId: decision.id,
      reviewedAssessmentId: decision.draftAssessmentId,
      reviewFingerprint: decision.approvalFingerprint as string,
      reviewerUserId: decision.reviewerUserId,
    },
  }
  // The line and diagnosis sources must be exactly the handoff's references (A5.9 named them; nothing else).
  if (canonicalLines.some((line) => !references.encounterActivityIds.includes(line.encounterActivityId))) return refuse('INTEGRITY_CONFLICT', 'a line source is outside the approved handoff')
  if (canonicalDiagnoses.some((diagnosis) => !references.encounterDiagnosisIds.includes(diagnosis.encounterDiagnosisId))) return refuse('INTEGRITY_CONFLICT', 'a diagnosis source is outside the approved handoff')
  const total = canonicalLines.reduce((sum, line) => sum + BigInt(line.extendedAmount.replace('.', '')), 0n)
  if (total !== BigInt(payload.financial.totalExtendedAmount.replace('.', ''))) return refuse('INTEGRITY_CONFLICT', 'the stored total is not the sum of the stored line amounts')

  const encoded = encodeCanonicalPayload(payload, moneyScale)
  return { outcome: 'COMPOSED' as const, organizationId: claim.encounter.patient.organizationId, payload, bytes: encoded.bytes, sha256: encoded.sha256 }
}

// ---- the read-only preview (§8) --------------------------------------------------------------------------

const errorCodeOf = { NOT_AUTHORIZED: 'CLAIM_PAYLOAD_NOT_AUTHORIZED', STALE: 'CLAIM_PAYLOAD_STALE', INCOMPLETE: 'CLAIM_PAYLOAD_INCOMPLETE', UNSUPPORTED: 'CLAIM_PAYLOAD_UNSUPPORTED', INTEGRITY_CONFLICT: 'INTEGRITY_CONFLICT', NOT_FOUND: 'NOT_FOUND', VALIDATION_ERROR: 'VALIDATION_ERROR' } as const

export async function previewCanonicalClaimPayload(claimId: string, body: unknown): Promise<ClaimPayloadResult<CanonicalPayloadPreviewDto>> {
  if (!isClaimPayloadUuid(claimId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid claim id' }
  const validated = validatePreviewBody(body)
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }
  // One READ ONLY REPEATABLE READ snapshot: Postgres itself refuses any write, so a preview persists nothing.
  const result = await withReadSnapshot(undefined, (tx) => composeCanonicalClaimPayload(claimId, validated.value.draftAssessmentId, validated.value.approvalDecisionId, tx))
  if (!result.ok) return { ok: false, code: errorCodeOf[result.outcome], message: result.message }
  return { ok: true, value: { schemaVersion: PAYLOAD_SCHEMA_VERSION, previewDigestSha256: result.sha256, byteLength: result.bytes.length, payload: result.payload } }
}
