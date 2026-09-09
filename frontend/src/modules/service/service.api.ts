import { readApiError } from '../../shared/api-error.ts'

export type Service = {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createService(
  organizationId: string,
  internalCode: string,
  displayName: string,
): Promise<Service> {
  const response = await fetch(`/api/organizations/${organizationId}/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ internalCode, displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<Service>
}

export async function loadServices(organizationId: string): Promise<Service[]> {
  const response = await fetch(`/api/organizations/${organizationId}/services`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: Service[] }
  return data.items
}
