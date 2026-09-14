import { readApiError } from '../../shared/api-error.ts'

export type RuleDefinition = {
  id: string
  organizationId: string | null
  ruleKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
  createdAt: string
  updatedAt: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createRuleDefinition(
  organizationId: string,
  ruleKey: string,
  displayName: string,
  jurisdictionCode: string,
): Promise<RuleDefinition> {
  return handle(
    await fetch(`/api/organizations/${organizationId}/rule-definitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ruleKey, displayName, jurisdictionCode }),
    }),
  )
}

export async function loadRuleDefinitions(organizationId: string): Promise<RuleDefinition[]> {
  const data = await handle<{ items: RuleDefinition[] }>(
    await fetch(`/api/organizations/${organizationId}/rule-definitions`),
  )
  return data.items
}
