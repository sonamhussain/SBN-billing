import type { DbClient } from '../../shared/database/database.types.ts'
import { findContextRows, findTargetRows } from './validation-run.repository.ts'
import type { ValidationFindingDraft, ValidationRunContextSnapshot } from './validation-run.types.ts'
import type { Outcome } from './validation-run.validation.ts'

// A5.7 §11 — defence in depth against cross-tenant and cross-Encounter mixing, before anything is
// inserted. This is NOT a second decision engine: nothing here re-runs eligibility, authorization,
// commercial resolution, evidence completeness or A3 precedence, and nothing is inferred from a
// field path or message. A missing row and another tenant's row are refused with the same message,
// so a refusal never discloses that foreign data exists.

export type RunOwner = { encounterId: string; patientId: string; organizationId: string }

const unusable = (field: string): Outcome<never> => ({ ok: false, message: `${field} is not a usable reference for this run` })

// A3 visibility: the run organization's own rows, or a SYSTEM_SHARED row that belongs to no tenant.
const isVisibleGovernance = (row: { organizationId: string | null; ownershipScope: string }, organizationId: string) =>
  row.organizationId === organizationId || (row.organizationId === null && row.ownershipScope === 'SYSTEM_SHARED')

// Owner-approved (A5.7 decision 2): every context id must exist and belong to the run's tenant — the
// membership to the Encounter's own patient, the profile to the snapshot facility, and the tariff
// chain to the snapshot contract. It is NOT required to equal the Encounter's current values: the
// snapshot records what was evaluated, not a declaration that it was valid.
export async function checkContextIntegrity(owner: RunOwner, context: ValidationRunContextSnapshot, db: DbClient): Promise<Outcome<true>> {
  const rows = await findContextRows(context, db)
  const org = owner.organizationId
  const field = (name: keyof ValidationRunContextSnapshot) => `contextSnapshot.${name}`

  if (rows.facility?.organizationId !== org) return unusable(field('facilityId'))
  if (rows.profile?.facilityId !== context.facilityId) return unusable(field('facilityRegulatoryProfileId'))
  if (context.insuranceMembershipId && rows.membership?.patientId !== owner.patientId) return unusable(field('insuranceMembershipId'))
  if (context.payerId && rows.payer?.organizationId !== org) return unusable(field('payerId'))
  if (context.tpaId && rows.tpa?.organizationId !== org) return unusable(field('tpaId'))
  if (context.networkId && rows.network?.organizationId !== org) return unusable(field('networkId'))
  if (context.insuranceProductId && rows.product?.organizationId !== org) return unusable(field('insuranceProductId'))
  if (context.providerContractId && rows.contract?.organizationId !== org) return unusable(field('providerContractId'))
  if (context.tariffScheduleId && (context.providerContractId === null || rows.schedule?.providerContractId !== context.providerContractId))
    return unusable(field('tariffScheduleId'))
  if (context.tariffScheduleVersionId && (context.tariffScheduleId === null || rows.tariffVersion?.tariffScheduleId !== context.tariffScheduleId))
    return unusable(field('tariffScheduleVersionId'))
  return { ok: true, value: true }
}

const distinct = (findings: ValidationFindingDraft[], field: keyof ValidationFindingDraft) =>
  [...new Set(findings.map((finding) => finding[field]).filter((value): value is string => typeof value === 'string'))]

export async function checkFindingReferences(owner: RunOwner, findings: ValidationFindingDraft[], db: DbClient): Promise<Outcome<true>> {
  const rows = await findTargetRows(
    {
      activities: distinct(findings, 'encounterActivityId'),
      diagnoses: distinct(findings, 'encounterDiagnosisId'),
      eligibilityVerifications: distinct(findings, 'eligibilityVerificationId'),
      priorAuthorizationVersions: distinct(findings, 'priorAuthorizationVersionId'),
      authorizationLines: distinct(findings, 'authorizationLineId'),
      evidenceRequirements: distinct(findings, 'evidenceRequirementId'),
      evidenceVersions: distinct(findings, 'evidenceArtifactVersionId'),
      ruleVersions: distinct(findings, 'ruleVersionId'),
      sourceVersions: distinct(findings, 'governingSourceVersionId'),
      datasetVersions: distinct(findings, 'referenceDatasetVersionId'),
    },
    db,
  )
  const org = owner.organizationId
  const encounter = owner.encounterId

  // The id of every row that passed its own check; a reference is usable only if it is in its set.
  const usable = {
    encounterActivityId: new Set(rows.activities.filter((row) => row.encounterId === encounter).map((row) => row.id)),
    encounterDiagnosisId: new Set(rows.diagnoses.filter((row) => row.encounterId === encounter).map((row) => row.id)),
    eligibilityVerificationId: new Set(rows.eligibilityVerifications.filter((row) => row.encounterId === encounter).map((row) => row.id)),
    priorAuthorizationVersionId: new Set(rows.priorAuthorizationVersions.filter((row) => row.priorAuthorization.encounterId === encounter).map((row) => row.id)),
    authorizationLineId: new Set(
      rows.authorizationLines.filter((row) => row.priorAuthorizationVersion.priorAuthorization.encounterId === encounter).map((row) => row.id),
    ),
    // Owner-approved (A5.7 decision 3): a requirement is usable only under a visible RuleVersion.
    evidenceRequirementId: new Set(rows.evidenceRequirements.filter((row) => isVisibleGovernance(row.ruleVersion.rule, org)).map((row) => row.id)),
    evidenceArtifactVersionId: new Set(rows.evidenceVersions.filter((row) => row.evidenceArtifact.organizationId === org).map((row) => row.id)),
    ruleVersionId: new Set(rows.ruleVersions.filter((row) => isVisibleGovernance(row.rule, org)).map((row) => row.id)),
    governingSourceVersionId: new Set(rows.sourceVersions.filter((row) => isVisibleGovernance(row.source, org)).map((row) => row.id)),
    // Reference datasets belong to no tenant; the exact version must simply exist.
    referenceDatasetVersionId: new Set(rows.datasetVersions.map((row) => row.id)),
  }

  for (const [index, finding] of findings.entries()) {
    for (const [field, allowed] of Object.entries(usable) as [keyof typeof usable, Set<string>][]) {
      const id = finding[field]
      if (id !== null && !allowed.has(id)) return unusable(`findings[${index}].${field}`)
    }
  }
  return { ok: true, value: true }
}
