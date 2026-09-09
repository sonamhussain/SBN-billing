import { readApiError } from '../../shared/api-error.ts'

export type DiagnosisCode = {
  id: string
  organizationId: string
  code: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export async function createDiagnosisCode(
  organizationId: string,
  code: string,
  displayName: string,
): Promise<DiagnosisCode> {
  const response = await fetch(`/api/organizations/${organizationId}/diagnosis-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<DiagnosisCode>
}

export async function loadDiagnosisCodes(organizationId: string): Promise<DiagnosisCode[]> {
  const response = await fetch(`/api/organizations/${organizationId}/diagnosis-codes`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: DiagnosisCode[] }
  return data.items
}
