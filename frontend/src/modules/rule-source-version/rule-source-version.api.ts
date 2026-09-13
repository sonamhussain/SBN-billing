import { readApiError } from '../../shared/api-error.ts'

export type RuleSourceVersion = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  publicationStatus: string
  publicationDate: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  activationStatus: string
  activationBlockers: string[]
  activatedAt: string | null
  suspendedAt: string | null
  supersededAt: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createRuleSourceVersion(
  sourceId: string,
  version: string,
  rawEvidenceRef: string,
): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-sources/${sourceId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, rawEvidenceRef }),
    }),
  )
}

export async function loadRuleSourceVersions(sourceId: string): Promise<RuleSourceVersion[]> {
  const data = await handle<{ items: RuleSourceVersion[] }>(await fetch(`/api/rule-sources/${sourceId}/versions`))
  return data.items
}

export async function updateLifecycleMetadata(
  id: string,
  publicationDate: string,
  effectiveFrom: string,
  effectiveTo: string,
): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/lifecycle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(publicationDate ? { publicationDate } : {}),
        ...(effectiveFrom ? { effectiveFrom } : {}),
        ...(effectiveTo ? { effectiveTo } : {}),
      }),
    }),
  )
}

export async function publishRuleSourceVersion(id: string): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
}

export async function updateSourceVerification(id: string, verificationStatus: string): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationStatus }),
    }),
  )
}

export async function evaluateActivation(
  id: string,
  businessDate: string,
  jurisdictionCode: string,
): Promise<{ blockers: string[] }> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/activation/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessDate, jurisdictionCode }),
    }),
  )
}

export async function activateRuleSourceVersion(
  id: string,
  businessDate: string,
  jurisdictionCode: string,
): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessDate, jurisdictionCode }),
    }),
  )
}

export async function suspendRuleSourceVersion(id: string): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
}

export async function resumeRuleSourceVersion(
  id: string,
  businessDate: string,
  jurisdictionCode: string,
): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessDate, jurisdictionCode }),
    }),
  )
}

export async function retireRuleSourceVersion(id: string): Promise<RuleSourceVersion> {
  return handle(
    await fetch(`/api/rule-source-versions/${id}/retire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
}
