import { readApiError } from '../../shared/api-error.ts'

export const relationshipTypes = ['SUPERSEDES', 'AMENDS', 'REFERENCES', 'DEPENDS_ON', 'CONFLICTS_WITH'] as const

export type RelationshipType = (typeof relationshipTypes)[number]

export type RuleSourceRelationship = {
  id: string
  fromSourceVersionId: string
  toSourceVersionId: string
  relationshipType: string
  createdAt: string
  direction: 'incoming' | 'outgoing'
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createRelationship(
  fromVersionId: string,
  toSourceVersionId: string,
  relationshipType: RelationshipType,
): Promise<RuleSourceRelationship> {
  return handle(
    await fetch(`/api/rule-source-versions/${fromVersionId}/relationships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toSourceVersionId, relationshipType }),
    }),
  )
}

export async function loadRelationships(versionId: string): Promise<RuleSourceRelationship[]> {
  const data = await handle<{ items: RuleSourceRelationship[] }>(
    await fetch(`/api/rule-source-versions/${versionId}/relationships?direction=all`),
  )
  return data.items
}
