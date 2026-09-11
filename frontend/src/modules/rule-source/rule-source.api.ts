import { readApiError } from '../../shared/api-error.ts'

export const sourceCategories = [
  'REGULATORY_AUTHORITY',
  'CLAIMS_STANDARD',
  'TARIFF',
  'PROVIDER_CONTRACT',
  'PAYER_POLICY',
  'TPA_POLICY',
  'CLINICAL_STANDARD',
  'RESEARCH_PUBLICATION',
  'OPERATIONAL_GUIDANCE',
  'OTHER',
] as const

export type SourceCategory = (typeof sourceCategories)[number]

export type RuleSource = {
  id: string
  organizationId: string | null
  jurisdictionCode: string
  issuingAuthority: string
  sourceCategory: string
  referenceNumber: string
  title: string
  ownershipScope: string
  createdAt: string
  updatedAt: string
}

export async function createRuleSource(
  organizationId: string,
  jurisdictionCode: string,
  issuingAuthority: string,
  sourceCategory: SourceCategory,
  referenceNumber: string,
  title: string,
): Promise<RuleSource> {
  const response = await fetch(`/api/organizations/${organizationId}/rule-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jurisdictionCode, issuingAuthority, sourceCategory, referenceNumber, title }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<RuleSource>
}

export async function loadRuleSources(organizationId: string): Promise<RuleSource[]> {
  const response = await fetch(`/api/organizations/${organizationId}/rule-sources`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: RuleSource[] }
  return data.items
}
