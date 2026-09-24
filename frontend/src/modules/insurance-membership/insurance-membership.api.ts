import { readApiError } from '../../shared/api-error.ts'

// A4.3 — the minimal developer-check client. Member and policy identifiers travel only in request
// and response bodies: never in a URL, never logged, never written to localStorage/sessionStorage.

export type InsuranceMembership = {
  id: string
  patientId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  memberIdentifier: string
  policyIdentifier: string | null
  coverageFrom: string | null
  coverageTo: string | null
  createdAt: string
  updatedAt: string
}

export type MembershipInput = {
  payerId: string
  tpaId: string
  networkId: string
  insuranceProductId: string
  memberIdentifier: string
  policyIdentifier: string
  coverageFrom: string
  coverageTo: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

// A blank optional field is sent as null, which records "unknown" / clears it server-side.
const optional = (value: string) => (value.trim() === '' ? null : value)

export async function createMembership(patientId: string, input: MembershipInput): Promise<InsuranceMembership> {
  return handle(
    await fetch(`/api/patients/${patientId}/insurance-memberships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payerId: input.payerId,
        tpaId: optional(input.tpaId),
        networkId: optional(input.networkId),
        insuranceProductId: optional(input.insuranceProductId),
        memberIdentifier: input.memberIdentifier,
        policyIdentifier: optional(input.policyIdentifier),
        coverageFrom: optional(input.coverageFrom),
        coverageTo: optional(input.coverageTo),
      }),
    }),
  )
}

export async function listMemberships(patientId: string): Promise<InsuranceMembership[]> {
  const body = await handle<{ items: InsuranceMembership[] }>(await fetch(`/api/patients/${patientId}/insurance-memberships`))
  return body.items
}

export async function getMembership(id: string): Promise<InsuranceMembership> {
  return handle(await fetch(`/api/insurance-memberships/${id}`))
}

// Only the supplied fields are sent, so an untouched field is never overwritten.
export async function patchMembership(id: string, patch: Record<string, string | null>): Promise<InsuranceMembership> {
  return handle(
    await fetch(`/api/insurance-memberships/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}
