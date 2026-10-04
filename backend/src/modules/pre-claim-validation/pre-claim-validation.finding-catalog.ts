import type { ValidationLayer } from '../validation-run/validation-run.types.ts'
// A5.2 owns freshness. Its pure rule is reused exactly; A5.8 never writes a second one.
import { evaluateFreshness } from '../eligibility-verification/eligibility-verification.validation.ts'
import type { AuthorizationScopeOutcome } from '../authorization-line/authorization-line.types.ts'
import type { CatalogEntry, FindingDraft } from './pre-claim-validation.types.ts'

// A5-VAL-1 — the fixed finding catalogue. Every findingCode, its layer, its outcome and its frozen
// human message are defined here once. Messages name a check category only: no member, policy,
// authorization reference, evidence or clinical value ever appears in one.

export const findingCatalog = {
  // §8 TECHNICAL
  TECHNICAL_CONTEXT_VALID: { layer: 'TECHNICAL', outcome: 'PASS', message: 'The stored encounter membership, clinician assignment, regulatory profile and commercial coherence are consistent.' },
  TECHNICAL_CONTEXT_INTEGRITY_FAIL: { layer: 'TECHNICAL', outcome: 'FAIL', message: 'A stored encounter context relationship contradicts itself; dependent validation layers were not executed.' },
  // §9 CODING
  CODING_DIAGNOSIS_INVARIANTS_PASS: { layer: 'CODING', outcome: 'PASS', message: 'Active encounter diagnoses satisfy their owner invariants.' },
  CODING_DIAGNOSIS_INTEGRITY_FAIL: { layer: 'CODING', outcome: 'FAIL', message: 'Stored active encounter diagnoses violate their owner invariants.' },
  CODING_ACTIVITY_INVARIANTS_PASS: { layer: 'CODING', outcome: 'PASS', message: 'Active encounter activities and modifiers satisfy their owner invariants.' },
  CODING_ACTIVITY_INTEGRITY_FAIL: { layer: 'CODING', outcome: 'FAIL', message: 'A stored encounter activity or modifier set violates its owner invariants.' },
  CODING_OBSERVATION_INVARIANTS_PASS: { layer: 'CODING', outcome: 'PASS', message: 'Active encounter observations satisfy their typed-value owner invariants.' },
  CODING_OBSERVATION_INTEGRITY_FAIL: { layer: 'CODING', outcome: 'FAIL', message: 'A stored encounter observation violates its typed-value owner invariants.' },
  // §10 COVERAGE — eligibility
  COVERAGE_MEMBERSHIP_MISSING: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The encounter has no selected insurance membership.' },
  COVERAGE_ELIGIBILITY_ELIGIBLE: { layer: 'COVERAGE', outcome: 'PASS', message: 'Exactly one fresh eligibility verification for this context reports eligible.' },
  COVERAGE_ELIGIBILITY_INELIGIBLE: { layer: 'COVERAGE', outcome: 'FAIL', message: 'Exactly one fresh eligibility verification for this context reports ineligible.' },
  COVERAGE_ELIGIBILITY_UNKNOWN: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'Exactly one fresh eligibility verification for this context reports an unknown status.' },
  COVERAGE_ELIGIBILITY_AMBIGUOUS: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'More than one fresh eligibility verification matches this context; none is chosen.' },
  COVERAGE_ELIGIBILITY_STALE: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'Only stale eligibility verifications match this context.' },
  COVERAGE_ELIGIBILITY_FRESHNESS_UNKNOWN: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'Matching eligibility verifications have no validity boundary, so their freshness is unknown.' },
  COVERAGE_ELIGIBILITY_MISSING: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'No eligibility verification matches this exact membership, commercial and service-date context.' },
  // §11 COVERAGE — authorization requirement and scope
  COVERAGE_AUTHORIZATION_NOT_REQUIRED: { layer: 'COVERAGE', outcome: 'PASS', message: 'The selected eligibility verification states that authorization is not required.' },
  COVERAGE_AUTHORIZATION_REQUIREMENT_UNKNOWN: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'Whether authorization is required is unknown for this context.' },
  COVERAGE_AUTHORIZATION_MISSING: { layer: 'COVERAGE', outcome: 'FAIL', message: 'Authorization is required but no prior authorization case exists for this encounter.' },
  COVERAGE_AUTHORIZATION_SCOPE_MATCHED: { layer: 'COVERAGE', outcome: 'PASS', message: 'The latest recorded authorization version scopes this activity.' },
  COVERAGE_AUTHORIZATION_SCOPE_NO_MATCH: { layer: 'COVERAGE', outcome: 'FAIL', message: 'No line of the latest recorded authorization version scopes this activity.' },
  COVERAGE_AUTHORIZATION_SCOPE_AMBIGUOUS: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'More than one line of the latest recorded authorization version scopes this activity.' },
  COVERAGE_AUTHORIZATION_CONTEXT_MISMATCH: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The authorization case was recorded for a different encounter context.' },
  COVERAGE_AUTHORIZATION_HEADER_NOT_APPROVED: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The latest recorded authorization version is not approved.' },
  COVERAGE_AUTHORIZATION_LINE_NOT_APPROVED: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The authorization line for this activity is not approved.' },
  COVERAGE_AUTHORIZATION_DATE_OUTSIDE_SCOPE: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The service date is outside the authorized period.' },
  COVERAGE_AUTHORIZATION_UNIT_MISMATCH: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The activity unit does not match the authorized unit.' },
  COVERAGE_AUTHORIZATION_QUANTITY_UNKNOWN: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'The authorized quantity for this activity is unknown.' },
  COVERAGE_AUTHORIZATION_QUANTITY_EXCEEDED: { layer: 'COVERAGE', outcome: 'FAIL', message: 'The activity quantity exceeds the authorized quantity.' },
  COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED: { layer: 'COVERAGE', outcome: 'PASS', message: 'Exactly one authorization case scopes this activity.' },
  COVERAGE_AUTHORIZATION_ACTIVITY_AMBIGUOUS: { layer: 'COVERAGE', outcome: 'RESTRICT', message: 'More than one authorization case scopes this activity; none is chosen.' },
  COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED: { layer: 'COVERAGE', outcome: 'FAIL', message: 'No authorization case scopes this activity.' },
  // §12 CONTRACT
  CONTRACT_CONTEXT_RESOLVED: { layer: 'CONTRACT', outcome: 'PASS', message: 'Exactly one provider contract and one verified tariff version apply.' },
  CONTRACT_MEMBERSHIP_MISSING: { layer: 'CONTRACT', outcome: 'FAIL', message: 'No commercial context can be resolved without a selected membership.' },
  CONTRACT_NO_APPLICABLE_CONTRACT: { layer: 'CONTRACT', outcome: 'FAIL', message: 'No provider contract applies to this commercial and facility context.' },
  CONTRACT_AMBIGUOUS_CONTRACT: { layer: 'CONTRACT', outcome: 'RESTRICT', message: 'More than one provider contract applies; none is chosen.' },
  CONTRACT_NO_APPLICABLE_TARIFF_VERSION: { layer: 'CONTRACT', outcome: 'FAIL', message: 'No verified tariff version applies on the service date.' },
  CONTRACT_AMBIGUOUS_TARIFF_VERSION: { layer: 'CONTRACT', outcome: 'RESTRICT', message: 'More than one verified tariff version applies; none is chosen.' },
  CONTRACT_INDETERMINATE_TARIFF_DATES: { layer: 'CONTRACT', outcome: 'RESTRICT', message: 'A verified tariff version without a known start could apply on the service date.' },
  // §13 EVIDENCE
  EVIDENCE_REQUIREMENT_SATISFIED: { layer: 'EVIDENCE', outcome: 'PASS', message: 'The governed evidence requirement is satisfied.' },
  EVIDENCE_REQUIREMENT_MISSING: { layer: 'EVIDENCE', outcome: 'FAIL', message: 'No evidence candidate exists for the governed evidence requirement.' },
  EVIDENCE_REQUIREMENT_INCOMPLETE: { layer: 'EVIDENCE', outcome: 'RESTRICT', message: 'Too few valid evidence versions satisfy the governed evidence requirement.' },
  EVIDENCE_SOURCE_DATE_MISSING: { layer: 'EVIDENCE', outcome: 'RESTRICT', message: 'An evidence version lacks the source date the requirement needs.' },
  EVIDENCE_STALE: { layer: 'EVIDENCE', outcome: 'RESTRICT', message: 'An evidence version is older than the requirement allows.' },
  EVIDENCE_REQUIREMENT_RESOLUTION_BLOCKED: { layer: 'EVIDENCE', outcome: 'RESTRICT', message: 'An applicable documentation rule could not be resolved in governance for this target.' },
  EVIDENCE_REQUIREMENT_CONFIGURATION_INCOMPLETE: { layer: 'EVIDENCE', outcome: 'FAIL', message: 'A resolved documentation rule has no complete evidence requirement payload.' },
  EVIDENCE_NO_REQUIREMENTS_APPLY: { layer: 'EVIDENCE', outcome: 'PASS', message: 'No governed evidence requirement applies to any target of this encounter.' },
  EVIDENCE_EVALUATION_BLOCKED_COMMERCIAL_CONTEXT: { layer: 'EVIDENCE', outcome: 'RESTRICT', message: 'Evidence requirements were not evaluated because the commercial context is unresolved.' },
} as const satisfies Record<string, CatalogEntry>

export type FindingCode = keyof typeof findingCatalog

type Targets = Partial<Pick<FindingDraft, 'encounterActivityId' | 'encounterDiagnosisId' | 'eligibilityVerificationId' | 'priorAuthorizationVersionId' | 'authorizationLineId' | 'evidenceRequirementId' | 'evidenceArtifactVersionId'>>

// Builds one draft from the catalogue. A governed finding takes its rule and governing source ids from
// its exact provenance, never from anywhere else (§15).
export function draft(code: FindingCode, targets: Targets = {}, provenance: FindingDraft['provenance'] = null): FindingDraft {
  const entry = findingCatalog[code]
  return {
    layer: entry.layer,
    outcome: entry.outcome,
    findingCode: code,
    fieldPath: null,
    message: entry.message,
    ruleVersionId: provenance?.ruleVersionId ?? null,
    governingSourceVersionId: provenance?.governingSourceVersionId ?? null,
    // §15 — the singular reference only when exactly one dataset was consumed.
    referenceDatasetVersionId: provenance && provenance.referenceDatasetVersionIds.length === 1 ? provenance.referenceDatasetVersionIds[0] : null,
    encounterActivityId: targets.encounterActivityId ?? null,
    encounterDiagnosisId: targets.encounterDiagnosisId ?? null,
    eligibilityVerificationId: targets.eligibilityVerificationId ?? null,
    priorAuthorizationVersionId: targets.priorAuthorizationVersionId ?? null,
    authorizationLineId: targets.authorizationLineId ?? null,
    evidenceRequirementId: targets.evidenceRequirementId ?? null,
    evidenceArtifactVersionId: targets.evidenceArtifactVersionId ?? null,
    provenance,
  }
}

// ---- §10 eligibility selection --------------------------------------------------------------------

export type EligibilityRow = {
  id: string
  status: string
  validThrough: Date | null
  authorizationRequired: boolean | null
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  serviceDate: Date
}

export type EligibilityContext = {
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  serviceDate: Date
}

export type EligibilitySelection = { code: FindingCode; selected: EligibilityRow | null }

// Candidates are only the verifications whose frozen context equals this run's context exactly;
// freshness is A5.2's own rule at the run's evaluation instant. No row ever wins by respondedAt,
// createdAt or id: anything other than exactly one FRESH candidate is reported, never resolved.
export function selectEligibility(rows: EligibilityRow[], context: EligibilityContext, evaluatedAt: Date): EligibilitySelection {
  const candidates = rows.filter(
    (row) =>
      row.insuranceMembershipId === context.insuranceMembershipId &&
      row.payerId === context.payerId &&
      row.tpaId === context.tpaId &&
      row.networkId === context.networkId &&
      row.insuranceProductId === context.insuranceProductId &&
      row.serviceDate.getTime() === context.serviceDate.getTime(),
  )
  if (candidates.length === 0) return { code: 'COVERAGE_ELIGIBILITY_MISSING', selected: null }
  const freshness = candidates.map((row) => evaluateFreshness(row.validThrough, evaluatedAt))
  const fresh = candidates.filter((_, index) => freshness[index] === 'FRESH')
  if (fresh.length > 1) return { code: 'COVERAGE_ELIGIBILITY_AMBIGUOUS', selected: null }
  if (fresh.length === 1) {
    const [selected] = fresh
    if (selected.status === 'ELIGIBLE') return { code: 'COVERAGE_ELIGIBILITY_ELIGIBLE', selected }
    if (selected.status === 'INELIGIBLE') return { code: 'COVERAGE_ELIGIBILITY_INELIGIBLE', selected }
    return { code: 'COVERAGE_ELIGIBILITY_UNKNOWN', selected }
  }
  if (freshness.includes('STALE')) return { code: 'COVERAGE_ELIGIBILITY_STALE', selected: null }
  return { code: 'COVERAGE_ELIGIBILITY_FRESHNESS_UNKNOWN', selected: null }
}

// ---- §11 authorization ----------------------------------------------------------------------------

export const scopeOutcomeCodes: Record<AuthorizationScopeOutcome, FindingCode> = {
  MATCHED: 'COVERAGE_AUTHORIZATION_SCOPE_MATCHED',
  NO_MATCH: 'COVERAGE_AUTHORIZATION_SCOPE_NO_MATCH',
  AMBIGUOUS: 'COVERAGE_AUTHORIZATION_SCOPE_AMBIGUOUS',
  CONTEXT_MISMATCH: 'COVERAGE_AUTHORIZATION_CONTEXT_MISMATCH',
  HEADER_STATUS_NOT_APPROVED: 'COVERAGE_AUTHORIZATION_HEADER_NOT_APPROVED',
  LINE_STATUS_NOT_APPROVED: 'COVERAGE_AUTHORIZATION_LINE_NOT_APPROVED',
  DATE_OUTSIDE_SCOPE: 'COVERAGE_AUTHORIZATION_DATE_OUTSIDE_SCOPE',
  UNIT_MISMATCH: 'COVERAGE_AUTHORIZATION_UNIT_MISMATCH',
  QUANTITY_UNKNOWN: 'COVERAGE_AUTHORIZATION_QUANTITY_UNKNOWN',
  QUANTITY_EXCEEDED: 'COVERAGE_AUTHORIZATION_QUANTITY_EXCEEDED',
}

// One activity's summary across every evaluated latest-recorded version: exactly one MATCHED is
// satisfied; several are ambiguous and no case is chosen; none is unsatisfied.
export function activitySummaryCode(outcomes: AuthorizationScopeOutcome[]): FindingCode {
  const matched = outcomes.filter((outcome) => outcome === 'MATCHED').length
  if (matched === 1) return 'COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED'
  if (matched > 1) return 'COVERAGE_AUTHORIZATION_ACTIVITY_AMBIGUOUS'
  return 'COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED'
}

// ---- §12 contract -----------------------------------------------------------------------------------

// The A5.5 reasons A5-VAL-1 maps. A4_INTEGRITY_CONFLICT cannot reach here (the TECHNICAL gate already
// verified the same A4 relationships in this snapshot), and TARIFF_INTEGRITY_CONFLICT is an integrity
// defect (owner decision): both abort the run instead of becoming a finding.
export const contractReasonCodes: Record<string, FindingCode> = {
  NO_SELECTED_MEMBERSHIP: 'CONTRACT_MEMBERSHIP_MISSING',
  NO_APPLICABLE_CONTRACT: 'CONTRACT_NO_APPLICABLE_CONTRACT',
  AMBIGUOUS_CONTRACT: 'CONTRACT_AMBIGUOUS_CONTRACT',
  NO_APPLICABLE_TARIFF_VERSION: 'CONTRACT_NO_APPLICABLE_TARIFF_VERSION',
  AMBIGUOUS_TARIFF_VERSION: 'CONTRACT_AMBIGUOUS_TARIFF_VERSION',
  INDETERMINATE_TARIFF_DATES: 'CONTRACT_INDETERMINATE_TARIFF_DATES',
}

// ---- §13 evidence -----------------------------------------------------------------------------------

export const requirementStateCodes: Record<string, FindingCode> = {
  SATISFIED: 'EVIDENCE_REQUIREMENT_SATISFIED',
  MISSING: 'EVIDENCE_REQUIREMENT_MISSING',
  INCOMPLETE: 'EVIDENCE_REQUIREMENT_INCOMPLETE',
}

export const evidenceBlockCodes: Record<string, FindingCode> = {
  REQUIREMENT_RESOLUTION_BLOCKED: 'EVIDENCE_REQUIREMENT_RESOLUTION_BLOCKED',
  CONFIGURATION_INCOMPLETE: 'EVIDENCE_REQUIREMENT_CONFIGURATION_INCOMPLETE',
}

// ---- §14 deterministic ordering ---------------------------------------------------------------------

export const layerOrder: readonly ValidationLayer[] = ['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE']

const orderKeys = ['encounterActivityId', 'encounterDiagnosisId', 'priorAuthorizationVersionId', 'authorizationLineId', 'evidenceRequirementId', 'evidenceArtifactVersionId'] as const

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const compareNullsFirst = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : compareText(a, b))

// Display/history order only — never severity or precedence. A5.7 numbers the drafts 1..N in this order.
export function orderFindings(drafts: FindingDraft[]): FindingDraft[] {
  return [...drafts].sort((a, b) => {
    const layer = layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer)
    if (layer !== 0) return layer
    const code = compareText(a.findingCode, b.findingCode)
    if (code !== 0) return code
    for (const key of orderKeys) {
      const byKey = compareNullsFirst(a[key], b[key])
      if (byKey !== 0) return byKey
    }
    return 0
  })
}
