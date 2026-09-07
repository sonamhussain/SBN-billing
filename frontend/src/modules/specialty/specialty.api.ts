import { readApiError } from '../../shared/api-error.ts'

export type Specialty = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createSpecialty(organizationId: string, displayName: string): Promise<Specialty> {
  const response = await fetch(`/api/organizations/${organizationId}/specialties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<Specialty>
}

export async function loadSpecialties(organizationId: string): Promise<Specialty[]> {
  const response = await fetch(`/api/organizations/${organizationId}/specialties`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: Specialty[] }
  return data.items
}
