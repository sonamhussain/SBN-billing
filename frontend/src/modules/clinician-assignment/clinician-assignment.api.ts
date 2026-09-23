import { readApiError } from '../../shared/api-error.ts'

// A4.2 — the minimal developer-check client. Synthetic IDs only; nothing is stored in the browser
// and no assignment payload is logged or placed in a URL.

export type Assignment = {
  id: string
  clinicianId: string
  facilityId?: string
  specialtyId?: string
  effectiveFrom: string
  effectiveTo: string | null
  createdAt: string
  updatedAt: string
}

export type AssignmentKind = 'facility' | 'specialty'

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function createAssignment(
  kind: AssignmentKind,
  clinicianId: string,
  targetId: string,
  effectiveFrom: string,
  effectiveTo: string,
): Promise<Assignment> {
  const body = kind === 'facility' ? { facilityId: targetId } : { specialtyId: targetId }
  return handle(
    await post(`/api/clinicians/${clinicianId}/${kind}-assignments`, {
      ...body,
      effectiveFrom,
      // A blank end means the assignment is still open.
      effectiveTo: effectiveTo.trim() === '' ? null : effectiveTo,
    }),
  )
}

export async function listAssignments(kind: AssignmentKind, clinicianId: string): Promise<Assignment[]> {
  const body = await handle<{ items: Assignment[] }>(await fetch(`/api/clinicians/${clinicianId}/${kind}-assignments`))
  return body.items
}

export async function getAssignment(kind: AssignmentKind, id: string): Promise<Assignment> {
  return handle(await fetch(`/api/clinician-${kind}-assignments/${id}`))
}

// Closing sets the end date once; there is no route to reopen, extend or delete an assignment.
export async function closeAssignment(kind: AssignmentKind, id: string, effectiveTo: string): Promise<Assignment> {
  return handle(await post(`/api/clinician-${kind}-assignments/${id}/close`, { effectiveTo }))
}
