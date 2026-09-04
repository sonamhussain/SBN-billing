import { readApiError } from '../../shared/api-error.ts'

export type Organization = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export async function createOrganization(name: string): Promise<Organization> {
  const response = await fetch('/api/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(
      apiError.requestId
        ? `${apiError.message} (requestId: ${apiError.requestId})`
        : apiError.message,
    )
  }

  return response.json() as Promise<Organization>
}
