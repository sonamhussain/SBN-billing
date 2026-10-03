import type { DbClient } from '../../shared/database/database.types.ts'
// A4.5, A4.6 and A4.7 own their read invariants. Their exact loaders and checks are called; A5.8 does
// not reproduce diagnosis ordering, modifier uniqueness or typed-observation rules.
import { findActiveEncounterDiagnoses } from '../encounter-diagnosis/encounter-diagnosis.repository.ts'
import { checkReadInvariant } from '../encounter-diagnosis/encounter-diagnosis.validation.ts'
import { findActiveEncounterActivities } from '../encounter-activity/encounter-activity.repository.ts'
import { checkModifierInvariant } from '../encounter-activity/encounter-activity.validation.ts'
import { findActiveEncounterObservations } from '../encounter-observation/encounter-observation.repository.ts'
import { verifyStoredObservation } from '../encounter-observation/encounter-observation.validation.ts'
import { draft } from './pre-claim-validation.finding-catalog.ts'
import type { FindingDraft } from './pre-claim-validation.types.ts'

// §9 — A5-VAL-1 CODING executes owner invariants only. No payer-specific CLAIM_EDIT content is
// interpreted, because no typed executable payload for it exists.
export async function evaluateCoding(encounterId: string, tx: DbClient): Promise<FindingDraft[]> {
  const findings: FindingDraft[] = []

  const diagnoses = await findActiveEncounterDiagnoses(encounterId, tx)
  findings.push(draft(checkReadInvariant(diagnoses).ok ? 'CODING_DIAGNOSIS_INVARIANTS_PASS' : 'CODING_DIAGNOSIS_INTEGRITY_FAIL'))

  // One FAIL per activity whose modifier set breaks A4.6's rule, so the exact activity is named.
  const activities = await findActiveEncounterActivities(encounterId, tx)
  const brokenActivities = activities.filter((activity) => !checkModifierInvariant(activity.modifiers).ok)
  if (brokenActivities.length === 0) findings.push(draft('CODING_ACTIVITY_INVARIANTS_PASS'))
  for (const activity of brokenActivities) findings.push(draft('CODING_ACTIVITY_INTEGRITY_FAIL', { encounterActivityId: activity.id }))

  const observations = await findActiveEncounterObservations(encounterId, tx)
  const observationsHold = observations.every((row) => verifyStoredObservation({ ...row, activityEncounterId: row.encounterActivity?.encounterId ?? null }).ok)
  findings.push(draft(observationsHold ? 'CODING_OBSERVATION_INVARIANTS_PASS' : 'CODING_OBSERVATION_INTEGRITY_FAIL'))

  return findings
}
