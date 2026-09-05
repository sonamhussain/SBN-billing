import { readApiError } from '../../shared/api-error.ts'

export type Clinician = {
  id: string
  organizationId: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createClinician(organizationId: string, displayName: string): Promise<Clinician> {
  const response = await fetch(`/api/organizations/${organizationId}/clinicians`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<Clinician>
}

export async function loadClinicians(organizationId: string): Promise<Clinician[]> {
  const response = await fetch(`/api/organizations/${organizationId}/clinicians`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: Clinician[] }
  return data.items
}
