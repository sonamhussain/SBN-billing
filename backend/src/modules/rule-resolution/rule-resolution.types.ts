// A3.8 §5 — resolver outcomes. These are NOT billing decisions: a RESOLVED result only says
// "this is the exact RuleVersion and governing source candidate the evidence points to", and a
// BLOCKED_* result is the correct, deliberate answer whenever the evidence is ambiguous.
export const resolutionStatuses = [
  'RESOLVED',
  'REFERENCE_ONLY',
  'NO_MATCH',
  'BLOCKED_RULE_VERSION_CONFLICT',
  'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
  'BLOCKED_EXECUTABILITY',
] as const

export type ResolutionStatus = (typeof resolutionStatuses)[number]

// A3.8's own blocker vocabulary. Executability blockers are passed straight through from A3.7
// instead of being re-encoded here, so the two modules never drift apart.
export const resolutionBlockerCodes = [
  'RULE_VERSION_SPECIFICITY_TIE',
  'SOURCE_PRECEDENCE_TIE',
  'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE',
  'SUPERSEDES_CONTRADICTORY_DATES',
  'SOURCE_CONFLICT',
] as const

export type ResolutionBlockerCode = (typeof resolutionBlockerCodes)[number]

export type RuleResolutionDto = {
  resolutionStatus: ResolutionStatus
  precedencePolicyVersion: string
  ruleDefinitionId: string
  // Winner fields are null for every outcome that did not actually produce that winner — a
  // blocked or no-match response must never carry a manufactured winner (A3.8 §8).
  ruleVersionId: string | null
  ruleVersion: string | null
  governingBindingId: string | null
  governingSourceInterpretationId: string | null
  governingSourceVersionId: string | null
  governingSourceId: string | null
  supportingBindingIds: string[]
  matchedApplicabilityIds: string[]
  businessDate: string
  jurisdictionCode: string
  specificityScore: number | null
  // True when the resolved source version is no longer current (e.g. SUPERSEDED) but was the
  // applicable version for the requested businessDate. Provenance only — never permission to
  // execute billing now (A3.8 §13).
  historicalOnly: boolean
  blockers: string[]
}

export type RuleResolutionErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type RuleResolutionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuleResolutionErrorCode; message: string }
