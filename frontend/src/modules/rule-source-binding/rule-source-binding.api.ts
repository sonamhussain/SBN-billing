import { readApiError } from '../../shared/api-error.ts'

export const sourceRoles = ['GOVERNING', 'SUPPORTING'] as const
export type SourceRole = (typeof sourceRoles)[number]

export type RuleSourceBinding = {
  id: string
  ruleVersionId: string
  sourceInterpretationId: string
  sourceRole: string
  createdAt: string
}

export type ExecutabilityEvaluation = {
  gateStatus: 'BLOCKED' | 'POTENTIALLY_ALLOWED' | 'REFERENCE_ONLY'
  compatibilityPolicyVersion: string
  blockers: string[]
  matchedApplicabilityIds: string[]
  governingBindingIds: string[]
  supportingBindingIds: string[]
  candidateSourceInterpretationIds: string[]
  nextGate: string | null
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createRuleSourceBinding(
  ruleVersionId: string,
  sourceInterpretationId: string,
  sourceRole: SourceRole,
): Promise<RuleSourceBinding> {
  return handle(
    await fetch(`/api/rule-versions/${ruleVersionId}/source-bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceInterpretationId, sourceRole }),
    }),
  )
}

export async function loadRuleSourceBindings(ruleVersionId: string): Promise<RuleSourceBinding[]> {
  const data = await handle<{ items: RuleSourceBinding[] }>(
    await fetch(`/api/rule-versions/${ruleVersionId}/source-bindings`),
  )
  return data.items
}

export type ExecutabilityContextInputs = {
  facilityId: string
  payerId: string
  tpaId: string
  networkId: string
  insuranceProductId: string
  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
  serviceId: string
  procedureCodeId: string
  diagnosisCodeId: string
}

export async function evaluateExecutability(
  ruleVersionId: string,
  businessDate: string,
  dimensions: ExecutabilityContextInputs,
): Promise<ExecutabilityEvaluation> {
  return handle(
    await fetch(`/api/rule-versions/${ruleVersionId}/executability/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessDate,
        // facilityRegulatoryProfileId is intentionally never sent — the server resolves it from
        // facilityId + businessDate (REF-01 §10).
        facilityId: dimensions.facilityId || null,
        payerId: dimensions.payerId || null,
        tpaId: dimensions.tpaId || null,
        networkId: dimensions.networkId || null,
        insuranceProductId: dimensions.insuranceProductId || null,
        providerContractId: dimensions.providerContractId || null,
        tariffScheduleId: dimensions.tariffScheduleId || null,
        tariffScheduleVersionId: dimensions.tariffScheduleVersionId || null,
        serviceId: dimensions.serviceId || null,
        procedureCodeId: dimensions.procedureCodeId || null,
        diagnosisCodeId: dimensions.diagnosisCodeId || null,
      }),
    }),
  )
}
