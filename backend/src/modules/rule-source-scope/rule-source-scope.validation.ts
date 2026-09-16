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

// REF-01 §8 T61-T65: a matching scope row is not enough by itself — the matched row must also
// carry the category's own minimum proof dimension(s) (OR semantics within the list). A row that
// matches only through unrelated narrowing dimensions does not prove the required scope.
export const categoryMinimumScopeKeys: Readonly<Record<string, readonly ScopeDimensionKey[]>> = {
  PAYER_POLICY: ['payerId'],
  TPA_POLICY: ['tpaId'],
  PROVIDER_CONTRACT: ['providerContractId'],
  TARIFF: ['tariffScheduleId', 'tariffScheduleVersionId'],
}

export function categoryMinimumScopeSatisfied(
  sourceCategory: string,
  matchedRows: readonly Record<ScopeDimensionKey, string | null>[],
): boolean {
  const requiredKeys = categoryMinimumScopeKeys[sourceCategory]
  if (!requiredKeys) return true
  return matchedRows.some((row) => requiredKeys.some((key) => row[key] !== null))
}
