import type { DbClient } from '../../shared/database/database.types.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { provenanceContractVersion, type RuleDecisionProvenanceRefV1 } from '../rule-provenance/rule-provenance.types.ts'
import type { ValidationRunContextSnapshot } from '../validation-run/validation-run.types.ts'
import { type FindingDraft, ValidationIntegrityDefect } from './pre-claim-validation.types.ts'

// A5.8 §15–§17 — the exact A3-PROV-1 decision basis of each governed finding, verified against this
// run and normalized into the four append-only provenance tables. Nothing here selects, ranks or
// recomputes a rule: every id is copied from the provenance A3.9 composed, and is only checked.

export type TargetCodes = { serviceId: string | null; procedureCodeId: string | null; diagnosisCodeId: string | null }

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

// §17 — every rule must hold, or the whole execution is rolled back: a governed finding is never
// recorded with provenance that contradicts its run, its target or itself.
export async function verifyGovernedProvenance(
  finding: FindingDraft,
  provenance: RuleDecisionProvenanceRefV1,
  run: { context: ValidationRunContextSnapshot; evaluatedAt: Date },
  target: TargetCodes,
  tx: DbClient,
): Promise<void> {
  const fail = (rule: string): never => {
    throw new ValidationIntegrityDefect(`governed finding provenance failed its integrity rule: ${rule}`)
  }
  if (provenance.provenanceContractVersion !== provenanceContractVersion) fail('contract version')
  if (provenance.precedencePolicyVersion.trim() === '') fail('policy version')
  if (finding.ruleVersionId !== provenance.ruleVersionId) fail('rule identity')
  if (finding.governingSourceVersionId !== provenance.governingSourceVersionId) fail('governing source')
  if (provenance.businessDate !== run.context.serviceDate) fail('business date')
  if (new Date(provenance.evaluationTimestamp).getTime() !== run.evaluatedAt.getTime()) fail('evaluation timestamp')
  // A5-VAL-1 consumes no reference dataset; none may be invented.
  if (provenance.referenceDatasetVersionIds.length !== 0 || finding.referenceDatasetVersionId !== null) fail('datasets')

  const c = provenance.context
  const r = run.context
  const contextMatches =
    c.facilityId === r.facilityId &&
    c.facilityRegulatoryProfileId === r.facilityRegulatoryProfileId &&
    c.payerId === r.payerId &&
    c.tpaId === r.tpaId &&
    c.networkId === r.networkId &&
    c.insuranceProductId === r.insuranceProductId &&
    c.providerContractId === r.providerContractId &&
    c.tariffScheduleId === r.tariffScheduleId &&
    c.tariffScheduleVersionId === r.tariffScheduleVersionId &&
    c.serviceId === target.serviceId &&
    c.procedureCodeId === target.procedureCodeId &&
    c.diagnosisCodeId === target.diagnosisCodeId
  if (!contextMatches) fail('context coherence')

  const governing = await tx.ruleSourceBinding.findUnique({
    where: { id: provenance.governingBindingId },
    select: { ruleVersionId: true, sourceInterpretationId: true, sourceInterpretation: { select: { sourceVersionId: true } } },
  })
  if (
    !governing ||
    governing.ruleVersionId !== provenance.ruleVersionId ||
    governing.sourceInterpretationId !== provenance.governingSourceInterpretationId ||
    governing.sourceInterpretation.sourceVersionId !== provenance.governingSourceVersionId
  )
    fail('governing binding')

  const supporting = await tx.ruleSourceBinding.findMany({ where: { id: { in: provenance.supportingBindingIds } }, select: { id: true, ruleVersionId: true } })
  if (!sameSet(supporting.map((row) => row.id), provenance.supportingBindingIds) || supporting.some((row) => row.ruleVersionId !== provenance.ruleVersionId))
    fail('supporting bindings')

  const applicabilities = await tx.ruleApplicability.findMany({ where: { id: { in: provenance.matchedApplicabilityIds } }, select: { id: true, ruleVersionId: true } })
  if (!sameSet(applicabilities.map((row) => row.id), provenance.matchedApplicabilityIds) || applicabilities.some((row) => row.ruleVersionId !== provenance.ruleVersionId))
    fail('matched applicability')
}

// Written in the run's own transaction, after A5.7 recorded the finding; the database refuses any
// later insert (owner-approved trigger).
export async function insertGovernedProvenance(validationFindingId: string, provenance: RuleDecisionProvenanceRefV1, tx: DbClient): Promise<void> {
  const businessDate = new Date(`${provenance.businessDate}T00:00:00.000Z`)
  if (formatDateOnly(businessDate) !== provenance.businessDate) throw new ValidationIntegrityDefect('governed finding provenance has an invalid business date')
  await tx.validationFindingRuleProvenance.create({
    data: {
      validationFindingId,
      provenanceContractVersion: provenance.provenanceContractVersion,
      precedencePolicyVersion: provenance.precedencePolicyVersion,
      rulePackVersionId: provenance.rulePackVersionId,
      governingBindingId: provenance.governingBindingId,
      governingSourceInterpretationId: provenance.governingSourceInterpretationId,
      businessDate,
      evaluationTimestamp: new Date(provenance.evaluationTimestamp),
      historicalOnly: provenance.historicalOnly,
    },
  })
  if (provenance.supportingBindingIds.length > 0)
    await tx.validationFindingSupportingBinding.createMany({ data: provenance.supportingBindingIds.map((ruleSourceBindingId) => ({ validationFindingId, ruleSourceBindingId })) })
  if (provenance.matchedApplicabilityIds.length > 0)
    await tx.validationFindingMatchedApplicability.createMany({ data: provenance.matchedApplicabilityIds.map((ruleApplicabilityId) => ({ validationFindingId, ruleApplicabilityId })) })
  if (provenance.referenceDatasetVersionIds.length > 0)
    await tx.validationFindingReferenceDatasetVersion.createMany({
      data: provenance.referenceDatasetVersionIds.map((referenceDatasetVersionId) => ({ validationFindingId, referenceDatasetVersionId })),
    })
}
