import { readApiError } from '../../shared/api-error.ts'

export type Payer = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createPayer(organizationId: string, displayName: string): Promise<Payer> {
  const response = await fetch(`/api/organizations/${organizationId}/payers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<Payer>
}

export async function loadPayers(organizationId: string): Promise<Payer[]> {
  const response = await fetch(`/api/organizations/${organizationId}/payers`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: Payer[] }
  return data.items
}
