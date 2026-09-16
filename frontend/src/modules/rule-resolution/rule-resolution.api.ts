import { readApiError } from '../../shared/api-error.ts'

export type RuleResolution = {
  resolutionStatus: string
  precedencePolicyVersion: string
  ruleDefinitionId: string
  ruleVersionId: string | null
  ruleVersion: string | null
  governingBindingId: string | null
  governingSourceInterpretationId: string | null
  governingSourceVersionId: string | null
  governingSourceId: string | null
  supportingBindingIds: string[]
  matchedApplicabilityIds: string[]
  businessDate: string
  jurisdictionCode: string
  specificityScore: number | null
  historicalOnly: boolean
  blockers: string[]
}

// Eleven client-suppliable dimensions. The twelfth (facilityRegulatoryProfileId) is resolved by
// the server from facilityId + businessDate and is deliberately not offered here.
export type ResolutionContextInputs = {
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

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function evaluateRuleResolution(
  ruleDefinitionId: string,
  businessDate: string,
  context: ResolutionContextInputs,
): Promise<RuleResolution> {
  return handle(
    await fetch(`/api/rule-definitions/${ruleDefinitionId}/resolution/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessDate,
        // jurisdiction, authority rank, category rank and any winner id are never sent — the
        // resolver derives them from the RuleDefinition and rejects them if supplied (A3.8 §7).
        facilityId: context.facilityId || null,
        payerId: context.payerId || null,
        tpaId: context.tpaId || null,
        networkId: context.networkId || null,
        insuranceProductId: context.insuranceProductId || null,
        providerContractId: context.providerContractId || null,
        tariffScheduleId: context.tariffScheduleId || null,
        tariffScheduleVersionId: context.tariffScheduleVersionId || null,
        serviceId: context.serviceId || null,
        procedureCodeId: context.procedureCodeId || null,
        diagnosisCodeId: context.diagnosisCodeId || null,
      }),
    }),
  )
}
