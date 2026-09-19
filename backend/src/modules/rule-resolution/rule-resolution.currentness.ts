import { isEffectiveOn } from '../../shared/rules/date-only.ts'

// Audit F02 — whether a resolved answer is current at the moment it is evaluated.
//
// Selection and currentness use different dates. businessDate chooses the applicable rule and
// source (A3.8 §9, §13). evaluationDate is the UTC calendar date of the one server timestamp
// captured when the request is evaluated, and describes whether those selected versions are
// still current now. Neither stored ACTIVE status nor an old businessDate alone answers both
// questions, and evaluationDate never influences which versions are selected.
//
// historicalOnly is provenance, never permission: false does not authorise billing or a claim
// submission, and NO_MATCH / BLOCKED_* outputs stay non-authoritative whatever the flag says.
//
// Every date comparison uses the one strict inclusive window (isEffectiveOn): a valid
// effectiveFrom is required, effectiveTo may be open, and an invalid or contradictory period is
// never current — so any doubt makes the answer historical, not current.

export type DatedVersion = {
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

export type DatedSourceVersion = DatedVersion & {
  activationStatus: string
}

// RESOLVED: historical when the selected RuleVersion is not in force on evaluationDate, or the
// winning source version is not ACTIVE, or it is not in force on evaluationDate.
export function isHistoricalOnlyResolved(
  selectedRuleVersion: DatedVersion,
  winningSourceVersion: DatedSourceVersion,
  evaluationDate: Date,
): boolean {
  return (
    !isEffectiveOn(selectedRuleVersion.effectiveFrom, selectedRuleVersion.effectiveTo, evaluationDate) ||
    winningSourceVersion.activationStatus !== 'ACTIVE' ||
    !isEffectiveOn(winningSourceVersion.effectiveFrom, winningSourceVersion.effectiveTo, evaluationDate)
  )
}

// REFERENCE_ONLY: historical when the selected RuleVersion is not in force on evaluationDate. A
// reference-only rule has no governing source, and none is invented for this check.
export function isHistoricalOnlyReference(selectedRuleVersion: DatedVersion, evaluationDate: Date): boolean {
  return !isEffectiveOn(selectedRuleVersion.effectiveFrom, selectedRuleVersion.effectiveTo, evaluationDate)
}
