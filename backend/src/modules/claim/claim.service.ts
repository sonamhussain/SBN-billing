import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// A5.9 owns the readiness, policy and recency decision. A6.1 calls its transaction-aware composer and
// never re-implements any part of it.
import { composeA6Handoff } from '../pre-claim-readiness/pre-claim-readiness.service.ts'
import { HANDOFF_SCHEMA_VERSION, type PreClaimReadinessErrorCode } from '../pre-claim-readiness/pre-claim-readiness.types.ts'
import { createClaimRecord, findAssessmentBinding, findClaimById, findClaimForAssessment, findClaimsForEncounter } from './claim.repository.ts'
import { CLAIM_CONTRACT_VERSION, type ClaimDto, type ClaimErrorCode, type ClaimListDto, type ClaimReadDto, type ClaimResult } from './claim.types.ts'
import { isClaimUuid, validateCreateClaimBody } from './claim.validation.ts'

// A6.1 §8/§9/§10 — create one A6-CLAIM-1 Claim from one exact eligible readiness assessment, and read
// Claims. Creation never executes validation, never re-resolves A5 context and never parses a finding.

const invalid = (message: string): ClaimResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const alreadyExists = (): ClaimResult<never> => ({ ok: false, code: 'CLAIM_ALREADY_EXISTS', message: 'a claim already exists for this readiness assessment' })
const bindingConflict = (): ClaimResult<never> => ({
  ok: false,
  code: 'CLAIM_BINDING_INTEGRITY_CONFLICT',
  message: 'the readiness assessment chain does not agree with the claim binding; nothing was written',
})

type StoredClaim = {
  id: string
  encounterId: string
  preClaimReadinessAssessmentId: string
  claimContractVersion: string
  handoffSchemaVersion: string
  createdByUserId: string
  createdAt: Date
}

function toClaimDto(record: StoredClaim): ClaimDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    preClaimReadinessAssessmentId: record.preClaimReadinessAssessmentId,
    claimContractVersion: record.claimContractVersion,
    handoffSchemaVersion: record.handoffSchemaVersion,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

function toClaimReadDto(record: StoredClaim & { preClaimReadinessAssessment: { validationRunId: string; state: string } }): ClaimReadDto {
  return {
    ...toClaimDto(record),
    source: { validationRunId: record.preClaimReadinessAssessment.validationRunId, readinessState: record.preClaimReadinessAssessment.state },
  }
}

// §12 — the audit trail proves a Claim was created, under which contracts and when — never the
// Encounter, assessment, run, patient, payer, findings, evidence or provenance it is bound to.
export const claimAuditSnapshot = (record: StoredClaim) => ({
  id: record.id,
  claimContractVersion: record.claimContractVersion,
  handoffSchemaVersion: record.handoffSchemaVersion,
  createdAt: record.createdAt.toISOString(),
})

// The A5.9 handoff refusals, restated in the Claim contract's own vocabulary.
const handoffRefusal: Record<PreClaimReadinessErrorCode, ClaimErrorCode> = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  PRECLAIM_NOT_READY_FOR_HANDOFF: 'PRECLAIM_NOT_READY_FOR_CLAIM',
  READINESS_POLICY_INCOMPATIBLE: 'CLAIM_HANDOFF_INCOMPATIBLE',
  READINESS_SUPERSEDED_BY_NEWER_VALIDATION: 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
  VALIDATION_RUN_RECENCY_AMBIGUOUS: 'VALIDATION_RUN_RECENCY_AMBIGUOUS',
  INTEGRITY_CONFLICT: 'CLAIM_BINDING_INTEGRITY_CONFLICT',
}

const handoffRefusalMessage: Partial<Record<ClaimErrorCode, string>> = {
  PRECLAIM_NOT_READY_FOR_CLAIM: 'only a READY_FOR_REVIEW readiness assessment can establish a claim',
  CLAIM_HANDOFF_INCOMPATIBLE: 'the A6-CLAIM-1 contract does not accept this assessment policy, validator version or handoff contract',
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
// The database coherence guard (claims_binding_coherence) is the backstop behind the check below.
const isCoherenceRefusal = (error: unknown) => error instanceof Error && error.message.includes('claims_binding_coherence')

class ClaimBindingConflict extends Error {}

export async function createClaim(assessmentId: string, body: unknown, actorUserId: string): Promise<ClaimResult<ClaimDto>> {
  if (!isClaimUuid(assessmentId)) return invalid('invalid readiness assessment id')
  const refused = validateCreateClaimBody(body)
  if (refused) return invalid(refused)

  try {
    return await prisma.$transaction(
      async (tx): Promise<ClaimResult<ClaimDto>> => {
        // The assessment row is locked (never modified) so two creates for the same assessment
        // serialize. The unique key on the Claim's assessment remains the backstop.
        if (!(await lockRowForUpdate(tx, 'pre_claim_readiness_assessments', assessmentId))) {
          return { ok: false, code: 'NOT_FOUND', message: 'readiness assessment not found' }
        }
        await concurrencyProbe('claim.assessment_locked')
        if (await findClaimForAssessment(assessmentId, tx)) return alreadyExists()

        // §8 — the A5.9 decision on this transaction's own snapshot: READY_FOR_REVIEW, A5-READY-1 over
        // A5-VAL-1, and no newer or tied validation run of the Encounter.
        const handoff = await composeA6Handoff(assessmentId, tx)
        if (!handoff.ok) {
          const code = handoffRefusal[handoff.code]
          return { ok: false, code, message: handoffRefusalMessage[code] ?? handoff.message }
        }
        if (handoff.value.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
          return { ok: false, code: 'CLAIM_HANDOFF_INCOMPATIBLE', message: handoffRefusalMessage.CLAIM_HANDOFF_INCOMPATIBLE as string }
        }

        // §7 — the Encounter is derived from the handoff and must equal the assessment's own run
        // Encounter; any disagreement is a defect, never repaired.
        const binding = await findAssessmentBinding(assessmentId, tx)
        const encounterId = handoff.value.validationRun.encounterId
        if (!binding || handoff.value.readinessAssessmentId !== assessmentId || binding.validationRun.encounterId !== encounterId) {
          throw new ClaimBindingConflict()
        }

        const claim = await createClaimRecord(
          {
            encounterId,
            preClaimReadinessAssessmentId: assessmentId,
            claimContractVersion: CLAIM_CONTRACT_VERSION,
            handoffSchemaVersion: handoff.value.schemaVersion,
            createdByUserId: actorUserId,
          },
          tx,
        )
        await concurrencyProbe('claim.inserted')

        await recordAuditEvent(
          {
            organizationId: binding.validationRun.encounter.patient.organizationId,
            actorUserId,
            actionCode: 'claim.created',
            entityType: 'CLAIM',
            entityId: claim.id,
            beforeState: null,
            afterState: claimAuditSnapshot(claim),
          },
          tx,
        )
        await concurrencyProbe('claim.created')
        return { ok: true, value: toClaimDto(claim) }
      },
      // §8 — one REPEATABLE READ read-write transaction: the handoff decision and the insert share a
      // snapshot, so the Claim can never bind a basis that was not eligible when it was written.
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 60_000 },
    )
  } catch (error) {
    if (isUniqueViolation(error)) return alreadyExists()
    if (error instanceof ClaimBindingConflict || isCoherenceRefusal(error)) return bindingConflict()
    throw error
  }
}

export async function getClaim(claimId: string): Promise<ClaimResult<ClaimReadDto>> {
  if (!isClaimUuid(claimId)) return invalid('invalid claim id')
  const claim = await findClaimById(claimId)
  if (!claim) return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
  return { ok: true, value: toClaimReadDto(claim) }
}

export async function listClaimsForEncounter(encounterId: string): Promise<ClaimResult<ClaimListDto>> {
  if (!isClaimUuid(encounterId)) return invalid('invalid encounter id')
  return { ok: true, value: { items: (await findClaimsForEncounter(encounterId)).map(toClaimReadDto) } }
}
