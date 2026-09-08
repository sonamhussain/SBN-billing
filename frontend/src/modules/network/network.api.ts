import { readApiError } from '../../shared/api-error.ts'

export type Network = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createNetwork(organizationId: string, displayName: string): Promise<Network> {
  const response = await fetch(`/api/organizations/${organizationId}/networks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<Network>
}

export async function loadNetworks(organizationId: string): Promise<Network[]> {
  const response = await fetch(`/api/organizations/${organizationId}/networks`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: Network[] }
  return data.items
}
