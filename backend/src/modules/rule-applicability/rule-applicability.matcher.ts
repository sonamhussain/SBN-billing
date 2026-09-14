import { applicabilityDimensionKeys } from './rule-applicability.validation.ts'

export type ApplicabilityContext = {
  payerId?: string | null
  tpaId?: string | null
  networkId?: string | null
  serviceId?: string | null
  procedureCodeId?: string | null
  diagnosisCodeId?: string | null
}

export type ApplicabilityRow = {
  id: string
  payerId: string | null
  tpaId: string | null
  networkId: string | null
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
