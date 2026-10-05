import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
// A5.7 owns run and finding persistence; their full rows are read through its repository only.
import { findFindingsForRun, findRunById } from '../validation-run/validation-run.repository.ts'
import { toRunDto } from '../validation-run/validation-run.service.ts'
import { decideRecency, isValidatorCompatible, reduceReadiness } from './pre-claim-readiness.policy.ts'
import {
  createAssessmentRecord,
  findAssessmentById,
  findAssessmentForRunAndPolicy,
  findAssessmentsForEncounter,
  findFindingOutcomes,
  findRecencyRelations,
  findRunForAssessment,
} from './pre-claim-readiness.repository.ts'
import {
  HANDOFF_SCHEMA_VERSION,
  type PreClaimA6HandoffV1,
  type PreClaimReadinessResult,
  READINESS_POLICY_VERSION,
  type ReadinessAssessmentDetailDto,
  type ReadinessAssessmentDto,
  type ReadinessAssessmentListDto,
  type ReadinessReasonRef,
} from './pre-claim-readiness.types.ts'
import { isReadinessUuid, validateAssessBody } from './pre-claim-readiness.validation.ts'

// A5.9 §7/§10/§15 — record one immutable assessment, read assessments, and derive the A6 handoff. A5.9
// never executes validation, never parses a finding message and never writes to a run or finding.

const invalid = (message: string): PreClaimReadinessResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const duplicate = (): PreClaimReadinessResult<never> => invalid('a readiness assessment already exists for this validation run and policy')

type StoredAssessment = {
  id: string
  validationRunId: string
  readinessPolicyVersion: string
  state: string
  assessedAt: Date
  createdByUserId: string
  createdAt: Date
}

function toAssessmentDto(record: StoredAssessment): ReadinessAssessmentDto {
  return {
    id: record.id,
    validationRunId: record.validationRunId,
    readinessPolicyVersion: record.readinessPolicyVersion,
    state: record.state,
    assessedAt: record.assessedAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

// §17 — the audit trail proves an assessment was recorded, under which policy, with which state and
// when — never the run, Encounter, findings, context, targets or provenance.
export const assessmentAuditSnapshot = (record: StoredAssessment) => ({
  id: record.id,
  readinessPolicyVersion: record.readinessPolicyVersion,
  state: record.state,
  assessedAt: record.assessedAt.toISOString(),
  createdAt: record.createdAt.toISOString(),
})

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

export async function recordReadinessAssessment(runId: string, body: unknown, actorUserId: string): Promise<PreClaimReadinessResult<ReadinessAssessmentDto>> {
  if (!isReadinessUuid(runId)) return invalid('invalid validation run id')
  const refused = validateAssessBody(body)
  if (refused) return invalid(refused)

  try {
    return await prisma.$transaction(async (tx): Promise<PreClaimReadinessResult<ReadinessAssessmentDto>> => {
      // The run row is locked (never modified) so two requests for the same run and policy serialize:
      // the second sees the first assessment. The unique key remains the backstop.
      if (!(await lockRowForUpdate(tx, 'validation_runs', runId))) return { ok: false, code: 'NOT_FOUND', message: 'validation run not found' }
      const run = await findRunForAssessment(runId, tx)
      if (!run) return { ok: false, code: 'NOT_FOUND', message: 'validation run not found' }
      await concurrencyProbe('pre_claim_readiness.run_locked')

      const findings = await findFindingOutcomes(runId, tx)
      const state = reduceReadiness(findings.map((finding) => finding.outcome))
      if (state === null) return { ok: false, code: 'INTEGRITY_CONFLICT', message: 'the validation run has no assessable finding set' }
      // §4 — an unknown validator contract is refused, never assumed to mean what A5-VAL-1 means.
      if (!isValidatorCompatible(READINESS_POLICY_VERSION, run.validatorVersion)) {
        return { ok: false, code: 'READINESS_POLICY_INCOMPATIBLE', message: 'the validation run was produced by a validator version this readiness policy does not accept' }
      }
      if (await findAssessmentForRunAndPolicy(runId, READINESS_POLICY_VERSION, tx)) return duplicate()

      const assessedAt = await readTransactionTimestamp(tx)
      const assessment = await createAssessmentRecord(
        { validationRunId: runId, readinessPolicyVersion: READINESS_POLICY_VERSION, state, assessedAt, createdByUserId: actorUserId },
        tx,
      )
      await concurrencyProbe('pre_claim_readiness.assessment_inserted')

      await recordAuditEvent(
        {
          organizationId: run.encounter.patient.organizationId,
          actorUserId,
          actionCode: 'pre_claim_readiness.recorded',
          entityType: 'PRE_CLAIM_READINESS_ASSESSMENT',
          entityId: assessment.id,
          beforeState: null,
          afterState: assessmentAuditSnapshot(assessment),
        },
        tx,
      )
      await concurrencyProbe('pre_claim_readiness.recorded')
      return { ok: true, value: toAssessmentDto(assessment) }
    })
  } catch (error) {
    if (isUniqueViolation(error)) return duplicate()
    throw error
  }
}

export async function listReadinessAssessments(encounterId: string): Promise<PreClaimReadinessResult<ReadinessAssessmentListDto>> {
  if (!isReadinessUuid(encounterId)) return invalid('invalid encounter id')
  return { ok: true, value: { items: (await findAssessmentsForEncounter(encounterId)).map(toAssessmentDto) } }
}

// §9 — reason sets derived from the run's immutable findings at read time, in sequence order.
export async function getReadinessAssessment(assessmentId: string): Promise<PreClaimReadinessResult<ReadinessAssessmentDetailDto>> {
  if (!isReadinessUuid(assessmentId)) return invalid('invalid readiness assessment id')
  return withReadSnapshot(undefined, async (tx) => {
    const assessment = await findAssessmentById(assessmentId, tx)
    if (!assessment) return { ok: false, code: 'NOT_FOUND', message: 'readiness assessment not found' }
    const findings = await findFindingOutcomes(assessment.validationRunId, tx)
    const withOutcome = (outcome: string): ReadinessReasonRef[] =>
      findings.filter((finding) => finding.outcome === outcome).map((finding) => ({ findingId: finding.id, sequence: finding.sequence, findingCode: finding.findingCode }))
    return {
      ok: true,
      value: {
        ...toAssessmentDto(assessment),
        reasons: {
          blockedFindings: withOutcome('FAIL'),
          restrictedFindings: withOutcome('RESTRICT'),
          warningFindings: withOutcome('WARNING'),
          passFindings: withOutcome('PASS'),
        },
      },
    }
  })
}

// §12 — exact, deduplicated, ascending; null is "no reference", never a value.
const exactSet = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null))].sort()

// §10/§11 — READY_FOR_REVIEW only, under A5-READY-1 over A5-VAL-1, and only while no later validation
// of the same Encounter exists. Every read shares one snapshot, so a run committed mid-read cannot
// produce a handoff that was never true. Nothing is written, and no pointer is stored.
export async function getA6Handoff(assessmentId: string): Promise<PreClaimReadinessResult<PreClaimA6HandoffV1>> {
  if (!isReadinessUuid(assessmentId)) return invalid('invalid readiness assessment id')
  return withReadSnapshot(undefined, async (tx): Promise<PreClaimReadinessResult<PreClaimA6HandoffV1>> => {
    const assessment = await findAssessmentById(assessmentId, tx)
    if (!assessment) return { ok: false, code: 'NOT_FOUND', message: 'readiness assessment not found' }
    if (assessment.state !== 'READY_FOR_REVIEW') {
      return { ok: false, code: 'PRECLAIM_NOT_READY_FOR_HANDOFF', message: 'only a READY_FOR_REVIEW assessment can be handed off' }
    }
    if (assessment.readinessPolicyVersion !== READINESS_POLICY_VERSION || !isValidatorCompatible(assessment.readinessPolicyVersion, assessment.validationRun.validatorVersion)) {
      return { ok: false, code: 'READINESS_POLICY_INCOMPATIBLE', message: 'this handoff contract does not accept the assessment policy or validator version' }
    }
    const recency = decideRecency(await findRecencyRelations(assessment.validationRunId, tx))
    if (recency === 'SUPERSEDED') {
      return { ok: false, code: 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION', message: 'a later validation run exists for this encounter' }
    }
    if (recency === 'AMBIGUOUS') {
      return { ok: false, code: 'VALIDATION_RUN_RECENCY_AMBIGUOUS', message: 'another validation run of this encounter has the same evaluation and creation time' }
    }

    const run = await findRunById(assessment.validationRunId, tx)
    if (!run) return { ok: false, code: 'NOT_FOUND', message: 'readiness assessment not found' }
    const findings = await findFindingsForRun(run.id, tx)
    const count = (outcome: string) => findings.filter((finding) => finding.outcome === outcome).length

    return {
      ok: true,
      value: {
        schemaVersion: HANDOFF_SCHEMA_VERSION,
        readinessAssessmentId: assessment.id,
        readinessPolicyVersion: 'A5-READY-1',
        readinessState: 'READY_FOR_REVIEW',
        assessedAt: assessment.assessedAt.toISOString(),
        validationRun: {
          id: run.id,
          validatorVersion: 'A5-VAL-1',
          evaluatedAt: run.evaluatedAt.toISOString(),
          encounterId: run.encounterId,
          context: toRunDto(run).context,
        },
        findingSummary: { total: findings.length, pass: count('PASS'), warning: count('WARNING'), restrict: count('RESTRICT'), fail: count('FAIL') },
        findingRefs: findings.map((finding) => ({ id: finding.id, sequence: finding.sequence, layer: finding.layer, outcome: finding.outcome, findingCode: finding.findingCode })),
        exactReferences: {
          encounterActivityIds: exactSet(findings.map((finding) => finding.encounterActivityId)),
          encounterDiagnosisIds: exactSet(findings.map((finding) => finding.encounterDiagnosisId)),
          eligibilityVerificationIds: exactSet(findings.map((finding) => finding.eligibilityVerificationId)),
          priorAuthorizationVersionIds: exactSet(findings.map((finding) => finding.priorAuthorizationVersionId)),
          authorizationLineIds: exactSet(findings.map((finding) => finding.authorizationLineId)),
          evidenceRequirementIds: exactSet(findings.map((finding) => finding.evidenceRequirementId)),
          evidenceArtifactVersionIds: exactSet(findings.map((finding) => finding.evidenceArtifactVersionId)),
          ruleVersionIds: exactSet(findings.map((finding) => finding.ruleVersionId)),
          governingSourceVersionIds: exactSet(findings.map((finding) => finding.governingSourceVersionId)),
          // A finding's base dataset reference plus every dataset version its A5.8 provenance consumed.
          referenceDatasetVersionIds: exactSet(
            findings.flatMap((finding) => [finding.referenceDatasetVersionId, ...finding.consumedDatasetVersions.map((row) => row.referenceDatasetVersionId)]),
          ),
        },
      },
    }
  })
}
