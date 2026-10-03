import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { findFindingById, findFindingsForRun, findRunById, findRunsForEncounter } from './validation-run.repository.ts'
import type { ValidationFindingDto, ValidationFindingListDto, ValidationRunDto, ValidationRunListDto, ValidationRunResult } from './validation-run.types.ts'
import { isValidationRunUuid } from './validation-run.validation.ts'

// A5.7 §10/§14 — read services only. Recording is the internal recorder's; there is no create,
// update, delete or execute service here, and no read labels a run current, best or approved.

const invalid = (message: string): ValidationRunResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

type StoredRun = {
  id: string
  encounterId: string
  serviceDate: Date
  facilityId: string
  facilityRegulatoryProfileId: string
  insuranceMembershipId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  validatorVersion: string
  evaluatedAt: Date
  createdByUserId: string
  createdAt: Date
  _count: { findings: number }
}

export function toRunDto(record: StoredRun): ValidationRunDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    evaluatedAt: record.evaluatedAt.toISOString(),
    validatorVersion: record.validatorVersion,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    context: {
      serviceDate: formatDateOnly(record.serviceDate) as string,
      facilityId: record.facilityId,
      facilityRegulatoryProfileId: record.facilityRegulatoryProfileId,
      insuranceMembershipId: record.insuranceMembershipId,
      payerId: record.payerId,
      tpaId: record.tpaId,
      networkId: record.networkId,
      insuranceProductId: record.insuranceProductId,
      providerContractId: record.providerContractId,
      tariffScheduleId: record.tariffScheduleId,
      tariffScheduleVersionId: record.tariffScheduleVersionId,
    },
    findingCount: record._count.findings,
  }
}

type StoredFinding = {
  id: string
  validationRunId: string
  sequence: number
  layer: string
  outcome: string
  findingCode: string
  fieldPath: string | null
  message: string
  ruleVersionId: string | null
  governingSourceVersionId: string | null
  referenceDatasetVersionId: string | null
  encounterActivityId: string | null
  encounterDiagnosisId: string | null
  eligibilityVerificationId: string | null
  priorAuthorizationVersionId: string | null
  authorizationLineId: string | null
  evidenceRequirementId: string | null
  evidenceArtifactVersionId: string | null
  createdAt: Date
  ruleProvenance: {
    provenanceContractVersion: string
    precedencePolicyVersion: string
    rulePackVersionId: string | null
    governingBindingId: string
    governingSourceInterpretationId: string
    businessDate: Date
    evaluationTimestamp: Date
    historicalOnly: boolean
  } | null
  supportingBindings: { ruleSourceBindingId: string }[]
  matchedApplicabilities: { ruleApplicabilityId: string }[]
  consumedDatasetVersions: { referenceDatasetVersionId: string }[]
}

const ascending = (ids: string[]) => [...ids].sort()

function toRuleProvenanceDto(record: StoredFinding): ValidationFindingDto['ruleProvenance'] {
  const meta = record.ruleProvenance
  if (!meta) return null
  return {
    provenanceContractVersion: meta.provenanceContractVersion,
    precedencePolicyVersion: meta.precedencePolicyVersion,
    rulePackVersionId: meta.rulePackVersionId,
    governingBindingId: meta.governingBindingId,
    governingSourceInterpretationId: meta.governingSourceInterpretationId,
    businessDate: formatDateOnly(meta.businessDate) as string,
    evaluationTimestamp: meta.evaluationTimestamp.toISOString(),
    historicalOnly: meta.historicalOnly,
    supportingBindingIds: ascending(record.supportingBindings.map((row) => row.ruleSourceBindingId)),
    matchedApplicabilityIds: ascending(record.matchedApplicabilities.map((row) => row.ruleApplicabilityId)),
    referenceDatasetVersionIds: ascending(record.consumedDatasetVersions.map((row) => row.referenceDatasetVersionId)),
  }
}

export function toFindingDto(record: StoredFinding): ValidationFindingDto {
  return {
    id: record.id,
    validationRunId: record.validationRunId,
    sequence: record.sequence,
    layer: record.layer,
    outcome: record.outcome,
    findingCode: record.findingCode,
    fieldPath: record.fieldPath,
    message: record.message,
    provenance: {
      ruleVersionId: record.ruleVersionId,
      governingSourceVersionId: record.governingSourceVersionId,
      referenceDatasetVersionId: record.referenceDatasetVersionId,
    },
    targets: {
      encounterActivityId: record.encounterActivityId,
      encounterDiagnosisId: record.encounterDiagnosisId,
      eligibilityVerificationId: record.eligibilityVerificationId,
      priorAuthorizationVersionId: record.priorAuthorizationVersionId,
      authorizationLineId: record.authorizationLineId,
      evidenceRequirementId: record.evidenceRequirementId,
      evidenceArtifactVersionId: record.evidenceArtifactVersionId,
    },
    ruleProvenance: toRuleProvenanceDto(record),
    createdAt: record.createdAt.toISOString(),
  }
}

export async function listValidationRuns(encounterId: string): Promise<ValidationRunResult<ValidationRunListDto>> {
  if (!isValidationRunUuid(encounterId)) return invalid('invalid encounter id')
  return { ok: true, value: { items: (await findRunsForEncounter(encounterId)).map(toRunDto) } }
}

export async function getValidationRun(runId: string): Promise<ValidationRunResult<ValidationRunDto>> {
  if (!isValidationRunUuid(runId)) return invalid('invalid validation run id')
  const record = await findRunById(runId)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'validation run not found' }
  return { ok: true, value: toRunDto(record) }
}

export async function listValidationFindings(runId: string): Promise<ValidationRunResult<ValidationFindingListDto>> {
  if (!isValidationRunUuid(runId)) return invalid('invalid validation run id')
  if (!(await findRunById(runId))) return { ok: false, code: 'NOT_FOUND', message: 'validation run not found' }
  return { ok: true, value: { items: (await findFindingsForRun(runId)).map(toFindingDto) } }
}

export async function getValidationFinding(findingId: string): Promise<ValidationRunResult<ValidationFindingDto>> {
  if (!isValidationRunUuid(findingId)) return invalid('invalid validation finding id')
  const record = await findFindingById(findingId)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'validation finding not found' }
  return { ok: true, value: toFindingDto(record) }
}
