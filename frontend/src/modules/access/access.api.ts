export type AccessProof = {
  organizationId: string
  membershipId: string
  permissions: string[]
}

export type AccessCheckResult =
  | { status: 'allowed'; proof: AccessProof }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }

export async function checkAccess(organizationId: string): Promise<AccessCheckResult> {
  const response = await fetch(`/api/access/organizations/${organizationId}`)

  if (response.status === 401) return { status: 'unauthenticated' }
  if (response.status === 403) return { status: 'forbidden' }

  if (!response.ok) {
    return { status: 'error', message: `Request failed: ${response.status}` }
  }

  const proof = (await response.json()) as AccessProof
  return { status: 'allowed', proof }
}
