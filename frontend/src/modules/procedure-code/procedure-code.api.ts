import { readApiError } from '../../shared/api-error.ts'

export type ProcedureCode = {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  codeSystem: string | null
  externalCode: string | null
  createdAt: string
  updatedAt: string
}

export async function createProcedureCode(
  organizationId: string,
  internalCode: string,
  displayName: string,
  codeSystem: string,
  externalCode: string,
): Promise<ProcedureCode> {
  const response = await fetch(`/api/organizations/${organizationId}/procedure-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ internalCode, displayName, codeSystem, externalCode }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<ProcedureCode>
}

export async function loadProcedureCodes(organizationId: string): Promise<ProcedureCode[]> {
  const response = await fetch(`/api/organizations/${organizationId}/procedure-codes`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: ProcedureCode[] }
  return data.items
}
