import { applicabilityDimensionKeys } from './rule-applicability.validation.ts'
import type { ApplicabilityContextV2 } from '../../shared/rules/applicability-context-v2.ts'

// REF-01 / R5: ApplicabilityContext is now the full twelve-dimension V2 shape — existing rows
// simply carry null for the six new columns, which the wildcard rule below already handles.
export type ApplicabilityContext = ApplicabilityContextV2

export type ApplicabilityRow = {
  id: string
  facilityId: string | null
  facilityRegulatoryProfileId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
}

// Within one row: every non-null dimension is AND. A null dimension on the row acts as a
// wildcard for that dimension. Missing/null context never satisfies a non-null requirement.
export function rowMatches(row: ApplicabilityRow, context: ApplicabilityContext): boolean {
  for (const key of applicabilityDimensionKeys) {
    const rowValue = row[key]
    if (rowValue === null) continue
    const contextValue = context[key]
    if (contextValue === undefined || contextValue === null || contextValue !== rowValue) return false
  }
  return true
}

// Across multiple rows: OR. Zero rows means applicability was never declared — never a match.
export function ruleVersionMatches(rows: ApplicabilityRow[], context: ApplicabilityContext): boolean {
  if (rows.length === 0) return false
  return rows.some((row) => rowMatches(row, context))
}

export function matchedApplicabilityIds(rows: ApplicabilityRow[], context: ApplicabilityContext): string[] {
  return rows.filter((row) => rowMatches(row, context)).map((row) => row.id)
}
