import { scopeDimensionKeys } from './rule-source-scope.validation.ts'

export type ScopeContext = {
  facilityId?: string | null
  payerId?: string | null
  tpaId?: string | null
  networkId?: string | null
  insuranceProductId?: string | null
  providerContractId?: string | null
  tariffScheduleId?: string | null
  tariffScheduleVersionId?: string | null
}

export type ScopeRow = {
  id: string
  facilityId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
}

// Mirrors A3.6's rowMatches exactly: within one row every non-null dimension is AND, a null
// dimension is a wildcard, and missing/null context never satisfies a non-null requirement.
export function scopeRowMatches(row: ScopeRow, context: ScopeContext): boolean {
  for (const key of scopeDimensionKeys) {
    const rowValue = row[key]
    if (rowValue === null) continue
    const contextValue = context[key]
    if (contextValue === undefined || contextValue === null || contextValue !== rowValue) return false
  }
  return true
}

// Across multiple rows: OR. Zero rows means scope was never declared — never a match (fail closed).
export function sourceScopeMatches(rows: ScopeRow[], context: ScopeContext): boolean {
  if (rows.length === 0) return false
  return rows.some((row) => scopeRowMatches(row, context))
}

export function matchedScopeIds(rows: ScopeRow[], context: ScopeContext): string[] {
  return rows.filter((row) => scopeRowMatches(row, context)).map((row) => row.id)
}

export function matchedScopeRows(rows: ScopeRow[], context: ScopeContext): ScopeRow[] {
  return rows.filter((row) => scopeRowMatches(row, context))
}
