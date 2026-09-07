import { readApiError } from '../../shared/api-error.ts'

export type Tpa = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createTpa(organizationId: string, displayName: string): Promise<Tpa> {
  const response = await fetch(`/api/organizations/${organizationId}/tpas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<Tpa>
}

export async function loadTpas(organizationId: string): Promise<Tpa[]> {
  const response = await fetch(`/api/organizations/${organizationId}/tpas`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: Tpa[] }
  return data.items
}
