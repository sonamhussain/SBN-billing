import { readApiError } from '../../shared/api-error.ts'

export const ruleEffectTypes = [
  'REFERENCE_ONLY',
  'PRICE_EFFECT',
  'TARIFF_EFFECT',
  'CLAIM_FORMAT_EFFECT',
  'CLAIM_EDIT_EFFECT',
  'REIMBURSEMENT_EFFECT',
  'AUTHORIZATION_REQUIREMENT_EFFECT',
  'ELIGIBILITY_REQUIREMENT_EFFECT',
  'DOCUMENTATION_REQUIREMENT_EFFECT',
] as const

export type RuleEffectType = (typeof ruleEffectTypes)[number]

export type RuleVersion = {
  id: string
  ruleId: string
  version: string
  effectType: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
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

export async function createRuleVersion(
  ruleId: string,
  version: string,
  effectType: RuleEffectType,
  effectiveFrom: string,
  effectiveTo: string,
): Promise<RuleVersion> {
  return handle(
    await fetch(`/api/rule-definitions/${ruleId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version,
        effectType,
        effectiveFrom: effectiveFrom || null,
        effectiveTo: effectiveTo || null,
      }),
    }),
  )
}

export async function loadRuleVersions(ruleId: string): Promise<RuleVersion[]> {
  const data = await handle<{ items: RuleVersion[] }>(await fetch(`/api/rule-definitions/${ruleId}/versions`))
  return data.items
}

export async function updateRuleVersionVerification(id: string, verificationStatus: string): Promise<RuleVersion> {
  return handle(
    await fetch(`/api/rule-versions/${id}/verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationStatus }),
    }),
  )
}
