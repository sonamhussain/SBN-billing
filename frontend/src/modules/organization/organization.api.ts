export type Organization = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

type ErrorResponse = {
  error?: { message?: string }
}

export async function createOrganization(name: string): Promise<Organization> {
  const response = await fetch('/api/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse
    throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
  }

  return response.json() as Promise<Organization>
}
