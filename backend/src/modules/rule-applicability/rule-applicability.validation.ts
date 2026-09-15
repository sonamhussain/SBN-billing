import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../../shared/rules/applicability-context-v2.ts'

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRuleApplicabilityUuid(value: string): boolean {
  return uuidShape.test(value)
}

// REF-01 / R5: re-exports the shared V2 contract under A3.6's original names so every existing
// consumer (A3.7 executability, this module's own service/route) keeps working unchanged while
// gaining the six new dimensions — A3.8 should import the shared names directly instead.
export const applicabilityDimensionKeys = APPLICABILITY_DIMENSIONS_V2
export type ApplicabilityDimensionKey = ApplicabilityDimensionKeyV2

export type OptionalUuidFieldResult = { valid: true; value: string | null } | { valid: false }

// A create/evaluate body never distinguishes "field omitted" from "field explicitly null" —
// both mean "no constraint on this dimension" (wildcard), unlike a PATCH body elsewhere.
export function normalizeOptionalUuidField(value: unknown): OptionalUuidFieldResult {
  if (value === undefined || value === null) return { valid: true, value: null }
  if (typeof value !== 'string' || !isRuleApplicabilityUuid(value)) return { valid: false }
  return { valid: true, value }
}
