import { readApiError } from '../../shared/api-error.ts'

export type RuleSourceVersion = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  createdAt: string
  updatedAt: string
}

export async function createRuleSourceVersion(
  sourceId: string,
  version: string,
  rawEvidenceRef: string,
): Promise<RuleSourceVersion> {
  const response = await fetch(`/api/rule-sources/${sourceId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, rawEvidenceRef }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<RuleSourceVersion>
}

export async function loadRuleSourceVersions(sourceId: string): Promise<RuleSourceVersion[]> {
  const response = await fetch(`/api/rule-sources/${sourceId}/versions`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: RuleSourceVersion[] }
  return data.items
}
