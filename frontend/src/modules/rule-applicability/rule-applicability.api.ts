import { readApiError } from '../../shared/api-error.ts'

export type RuleApplicability = {
  id: string
  ruleVersionId: string
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  createdAt: string
}

export type ApplicabilityDimensions = {
  payerId: string
  tpaId: string
  networkId: string
  serviceId: string
  procedureCodeId: string
  diagnosisCodeId: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

function dimensionsBody(dimensions: ApplicabilityDimensions) {
  return {
    payerId: dimensions.payerId || null,
    tpaId: dimensions.tpaId || null,
    networkId: dimensions.networkId || null,
    serviceId: dimensions.serviceId || null,
    procedureCodeId: dimensions.procedureCodeId || null,
    diagnosisCodeId: dimensions.diagnosisCodeId || null,
  }
}

export async function createRuleApplicability(
  ruleVersionId: string,
  dimensions: ApplicabilityDimensions,
): Promise<RuleApplicability> {
  return handle(
    await fetch(`/api/rule-versions/${ruleVersionId}/applicabilities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dimensionsBody(dimensions)),
    }),
  )
}

export async function loadRuleApplicabilities(ruleVersionId: string): Promise<RuleApplicability[]> {
  const data = await handle<{ items: RuleApplicability[] }>(
    await fetch(`/api/rule-versions/${ruleVersionId}/applicabilities`),
  )
  return data.items
}

export async function evaluateRuleApplicability(
  ruleVersionId: string,
  dimensions: ApplicabilityDimensions,
): Promise<{ matches: boolean; matchedApplicabilityIds: string[] }> {
  return handle(
    await fetch(`/api/rule-versions/${ruleVersionId}/applicability/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dimensionsBody(dimensions)),
    }),
  )
}
