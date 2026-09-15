const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRuleSourceScopeUuid(value: string): boolean {
  return uuidShape.test(value)
}

export const scopeDimensionKeys = [
  'facilityId',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'providerContractId',
  'tariffScheduleId',
  'tariffScheduleVersionId',
] as const

export type ScopeDimensionKey = (typeof scopeDimensionKeys)[number]

// Source categories that require a matching typed RuleSourceScope for a governing binding to
// pass A3.7's executability gate — REF-01 §8. Categories absent here (or never governing at
// all under A3-COMPAT-1) never need scope proof.
export const sourceCategoriesRequiringScope: readonly string[] = [
  'PAYER_POLICY',
  'TPA_POLICY',
  'PROVIDER_CONTRACT',
  'TARIFF',
]

export function categoryRequiresScope(sourceCategory: string): boolean {
  return sourceCategoriesRequiringScope.includes(sourceCategory)
}
