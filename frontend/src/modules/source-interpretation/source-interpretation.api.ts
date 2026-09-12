import { readApiError } from '../../shared/api-error.ts'

export const verificationStatuses = ['UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'REJECTED'] as const

export type VerificationStatus = (typeof verificationStatuses)[number]

export type SourceInterpretation = {
  id: string
  sourceVersionId: string
  interpretationVersion: string
  normalizedInterpretationRef: string
  verificationStatus: string
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export async function createSourceInterpretation(
  sourceVersionId: string,
  interpretationVersion: string,
  normalizedInterpretationRef: string,
): Promise<SourceInterpretation> {
  const response = await fetch(`/api/rule-source-versions/${sourceVersionId}/interpretations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interpretationVersion, normalizedInterpretationRef }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<SourceInterpretation>
}

export async function loadSourceInterpretations(sourceVersionId: string): Promise<SourceInterpretation[]> {
  const response = await fetch(`/api/rule-source-versions/${sourceVersionId}/interpretations`)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  const data = (await response.json()) as { items: SourceInterpretation[] }
  return data.items
}

export async function updateSourceInterpretationStatus(
  id: string,
  verificationStatus: VerificationStatus,
): Promise<SourceInterpretation> {
  const response = await fetch(`/api/source-interpretations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verificationStatus }),
  })
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<SourceInterpretation>
}
