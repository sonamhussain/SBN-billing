import { readApiError } from '../../shared/api-error.ts'

export type RulePack = {
  id: string
  organizationId: string | null
  packKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
}

export type RulePackVersion = {
  id: string
  rulePackId: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  activationStatus: string
  activatedAt: string | null
  supersededAt: string | null
}

export type RulePackMember = {
  id: string
  rulePackVersionId: string
  ruleVersionId: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

function post(url: string, body: unknown = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

// organizationId and ownershipScope are derived by the server from the URL and are never sent.
export async function createRulePack(organizationId: string, packKey: string, displayName: string, jurisdictionCode: string): Promise<RulePack> {
  return handle(await post(`/api/organizations/${organizationId}/rule-packs`, { packKey, displayName, jurisdictionCode }))
}

// Lifecycle fields (verification/activation) are never sent — they change only through the
// verify and activate actions below.
export async function createRulePackVersion(rulePackId: string, version: string, effectiveFrom: string, effectiveTo: string): Promise<RulePackVersion> {
  return handle(await post(`/api/rule-packs/${rulePackId}/versions`, { version, effectiveFrom: effectiveFrom || null, effectiveTo: effectiveTo || null }))
}

export async function getRulePackVersion(rulePackVersionId: string): Promise<RulePackVersion> {
  return handle(await fetch(`/api/rule-pack-versions/${rulePackVersionId}`))
}

export async function addRulePackMember(rulePackVersionId: string, ruleVersionId: string): Promise<RulePackMember> {
  return handle(await post(`/api/rule-pack-versions/${rulePackVersionId}/members`, { ruleVersionId }))
}

export async function listRulePackMembers(rulePackVersionId: string): Promise<RulePackMember[]> {
  const body = await handle<{ items: RulePackMember[] }>(await fetch(`/api/rule-pack-versions/${rulePackVersionId}/members`))
  return body.items
}

export async function verifyRulePackVersion(rulePackVersionId: string): Promise<RulePackVersion> {
  return handle(await post(`/api/rule-pack-versions/${rulePackVersionId}/verification`))
}

export async function activateRulePackVersion(rulePackVersionId: string, businessDate: string): Promise<RulePackVersion> {
  return handle(await post(`/api/rule-pack-versions/${rulePackVersionId}/activate`, { businessDate }))
}
