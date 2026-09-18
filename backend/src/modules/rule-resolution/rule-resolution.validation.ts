import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../../shared/rules/applicability-context-v2.ts'
import { resolutionStatuses, type ResolutionStatus } from './rule-resolution.types.ts'

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRuleResolutionUuid(value: string): boolean {
  return uuidShape.test(value)
}

// REF-01 carry-forward: A3.8 consumes the shared twelve-dimension ApplicabilityContextV2 and
// never re-declares the older six-dimension list. Of those twelve, facilityRegulatoryProfileId
// is server-derived from facilityId + businessDate (REF-01 §10), so a client may supply the
// other eleven. Anything a client sends for the derived dimension is ignored, exactly as on
// A3.7's executability endpoint.
export const serverDerivedResolutionContextKeys = ['facilityRegulatoryProfileId'] as const

export const resolutionContextKeys = APPLICABILITY_DIMENSIONS_V2.filter(
  (key) => !(serverDerivedResolutionContextKeys as readonly string[]).includes(key),
) as readonly ApplicabilityDimensionKeyV2[]

export type ResolutionContextKey = ApplicabilityDimensionKeyV2

// A3.8 §7: the client may never supply jurisdiction, ownership, authority rank, source category
// rank, version rank, publication rank or a winner id — those are either derived from the
// RuleDefinition or forbidden as precedence inputs entirely. Presence of any of them is a
// validation error rather than a silently ignored field, so a caller can never believe it
// influenced the outcome.
export const forbiddenResolutionRequestKeys = [
  'jurisdiction',
  'jurisdictionCode',
  'ownership',
  'ownershipScope',
  'authorityRank',
  'issuingAuthority',
  'sourceCategoryRank',
  'sourceCategory',
  'versionRank',
  'publicationRank',
  'publicationDate',
  'winnerId',
  'governingSourceId',
  'governingSourceVersionId',
  'governingSourceInterpretationId',
  'governingBindingId',
  'precedencePolicyVersion',
  // Audit F02: the evaluation instant is captured once, server-side. A client-supplied "today"
  // is never accepted, and historicalOnly is derived from it — neither can be requested.
  'evaluationDate',
  'evaluationTimestamp',
  'historicalOnly',
] as const

export function forbiddenResolutionKeysPresent(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  return forbiddenResolutionRequestKeys.filter((key) => Object.prototype.hasOwnProperty.call(body, key))
}

export function isResolutionStatus(value: unknown): value is ResolutionStatus {
  return typeof value === 'string' && (resolutionStatuses as readonly string[]).includes(value)
}
