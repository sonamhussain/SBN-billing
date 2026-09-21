import { readApiError } from '../../shared/api-error.ts'

// A4.1 — the minimal developer-check client. Patient data is never written to localStorage or
// sessionStorage, never logged, and never placed in a URL query parameter.

export type Patient = {
  id: string
  organizationId: string
  givenName: string
  middleName: string | null
  familyName: string
  displayName: string
  dateOfBirth: string
  mobilePhone: string | null
  email: string | null
  createdAt: string
  updatedAt: string
}

export type PatientInput = {
  givenName: string
  middleName: string
  familyName: string
  dateOfBirth: string
  mobilePhone: string
  email: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

// A blank optional field is sent as null, which is what clears it server-side.
const optional = (value: string) => (value.trim() === '' ? null : value)

export async function createPatient(organizationId: string, input: PatientInput): Promise<Patient> {
  return handle(
    await fetch(`/api/organizations/${organizationId}/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        givenName: input.givenName,
        middleName: optional(input.middleName),
        familyName: input.familyName,
        dateOfBirth: input.dateOfBirth,
        mobilePhone: optional(input.mobilePhone),
        email: optional(input.email),
      }),
    }),
  )
}

export async function listPatients(organizationId: string): Promise<Patient[]> {
  const body = await handle<{ items: Patient[] }>(await fetch(`/api/organizations/${organizationId}/patients`))
  return body.items
}

export async function getPatient(id: string): Promise<Patient> {
  return handle(await fetch(`/api/patients/${id}`))
}

// Only the supplied fields are sent, so an untouched field is never overwritten.
export async function patchPatient(id: string, patch: Record<string, string | null>): Promise<Patient> {
  return handle(
    await fetch(`/api/patients/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}
