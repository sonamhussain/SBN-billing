import type { DbClient } from '../../shared/database/database.types.ts'
// A5.6 owns governed evidence requirements and completeness, including the A3.8/A3.9 resolution and
// provenance behind them. A5.8 only chooses the deterministic target set and maps the exact result.
import { evaluateEvidenceCompleteness } from '../evidence-requirement/evidence-requirement.service.ts'
import { findActiveEncounterActivities } from '../encounter-activity/encounter-activity.repository.ts'
import { findActiveEncounterDiagnoses } from '../encounter-diagnosis/encounter-diagnosis.repository.ts'
import { draft, evidenceBlockCodes, requirementStateCodes } from './pre-claim-validation.finding-catalog.ts'
import { type FindingDraft, ValidationIntegrityDefect } from './pre-claim-validation.types.ts'

export type EvidenceTarget = { encounterActivityId: string | null; encounterDiagnosisId: string | null }

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// §13 — the Encounter itself, each active activity, each active diagnosis, and each active activity x
// active diagnosis pair (an applicability row may constrain both). UUID order throughout; a removed
// activity or diagnosis is never a target.
export async function evidenceTargets(encounterId: string, tx: DbClient): Promise<EvidenceTarget[]> {
  const activities = [...(await findActiveEncounterActivities(encounterId, tx))].sort(byId)
  const diagnoses = [...(await findActiveEncounterDiagnoses(encounterId, tx))].sort(byId)
  return [
    { encounterActivityId: null, encounterDiagnosisId: null },
    ...activities.map((activity) => ({ encounterActivityId: activity.id, encounterDiagnosisId: null })),
    ...diagnoses.map((diagnosis) => ({ encounterActivityId: null, encounterDiagnosisId: diagnosis.id })),
    ...activities.flatMap((activity) => diagnoses.map((diagnosis) => ({ encounterActivityId: activity.id, encounterDiagnosisId: diagnosis.id }))),
  ]
}

export async function evaluateEvidence(encounterId: string, commercialResolved: boolean, tx: DbClient): Promise<FindingDraft[]> {
  // No commercial ids are fabricated to reach A5.6.
  if (!commercialResolved) return [draft('EVIDENCE_EVALUATION_BLOCKED_COMMERCIAL_CONTEXT')]

  const findings: FindingDraft[] = []
  let requirementsSeen = 0
  for (const target of await evidenceTargets(encounterId, tx)) {
    const result = await evaluateEvidenceCompleteness(encounterId, target, tx)
    if (!result.ok) {
      const code = result.code === 'EVIDENCE_REQUIREMENT_UNRESOLVED' && result.reason ? evidenceBlockCodes[result.reason] : undefined
      if (!code) throw new ValidationIntegrityDefect('evidence completeness could not be evaluated in this snapshot')
      findings.push(draft(code, target))
      continue
    }
    for (const requirement of result.value.requirements) {
      requirementsSeen += 1
      // Every requirement finding — and every detail finding derived from it — is governed, and carries
      // the exact A3-PROV-1 provenance A5.6 composed for it.
      const targets = { ...target, evidenceRequirementId: requirement.evidenceRequirementId }
      findings.push(draft(requirementStateCodes[requirement.state], targets, requirement.provenance))
      for (const evidenceArtifactVersionId of requirement.invalidEvidenceArtifactVersionIds)
        findings.push(draft('EVIDENCE_SOURCE_DATE_MISSING', { ...targets, evidenceArtifactVersionId }, requirement.provenance))
      for (const evidenceArtifactVersionId of requirement.staleEvidenceArtifactVersionIds)
        findings.push(draft('EVIDENCE_STALE', { ...targets, evidenceArtifactVersionId }, requirement.provenance))
    }
  }
  if (requirementsSeen === 0 && findings.length === 0) findings.push(draft('EVIDENCE_NO_REQUIREMENTS_APPLY'))
  return findings
}
