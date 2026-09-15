const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRuleApplicabilityUuid(value: string): boolean {
  return uuidShape.test(value)
}

export const applicabilityDimensionKeys = [
  'payerId',
  'tpaId',
  'networkId',
  'serviceId',
  'procedureCodeId',
  'diagnosisCodeId',
] as const

export type ApplicabilityDimensionKey = (typeof applicabilityDimensionKeys)[number]

export type OptionalUuidFieldResult = { valid: true; value: string | null } | { valid: false }

// A create/evaluate body never distinguishes "field omitted" from "field explicitly null" —
// both mean "no constraint on this dimension" (wildcard), unlike a PATCH body elsewhere.
export function normalizeOptionalUuidField(value: unknown): OptionalUuidFieldResult {
  if (value === undefined || value === null) return { valid: true, value: null }
  if (typeof value !== 'string' || !isRuleApplicabilityUuid(value)) return { valid: false }
  return { valid: true, value }
}
