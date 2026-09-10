import { readApiError } from '../../shared/api-error.ts'

export const targetTypes = [
  'ORGANIZATION',
  'FACILITY',
  'CLINICIAN',
  'SPECIALTY',
  'PAYER',
  'TPA',
  'NETWORK',
  'SERVICE',
  'PROCEDURE_CODE',
  'DIAGNOSIS_CODE',
] as const

export type TargetType = (typeof targetTypes)[number]

export type ExternalIdentifier = {
  id: string
  organizationId: string
  sourceSystem: string
  externalValue: string
  target: { type: TargetType; id: string }
  createdAt: string
  updatedAt: string
}

export async function createExternalIdentifier(
  organizationId: string,
  sourceSystem: string,
  externalValue: string,
  targetType: TargetType,
  targetId: string,
): Promise<ExternalIdentifier> {
  const response = await fetch(`/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceSystem, externalValue, target: { type: targetType, id: targetId } }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<ExternalIdentifier>
}

export async function loadExternalIdentifiers(organizationId: string): Promise<ExternalIdentifier[]> {
  const response = await fetch(`/api/organizations/${organizationId}/external-identifiers`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: ExternalIdentifier[] }
  return data.items
}
