// A3-COMPAT-1 — controlled, fail-closed source-category / rule-effect compatibility policy.
// This is a code-controlled table, never a user-editable flag. Unknown/future categories or
// effect types default to INCOMPATIBLE until explicitly audited and added here.

export const compatibilityPolicyVersion = 'A3-COMPAT-1'

const sourceCategoryPermittedEffects: Readonly<Record<string, readonly string[]>> = {
  REGULATORY_AUTHORITY: [
    'CLAIM_FORMAT_EFFECT',
    'CLAIM_EDIT_EFFECT',
    'AUTHORIZATION_REQUIREMENT_EFFECT',
    'ELIGIBILITY_REQUIREMENT_EFFECT',
    'DOCUMENTATION_REQUIREMENT_EFFECT',
  ],
  CLAIMS_STANDARD: ['CLAIM_FORMAT_EFFECT', 'CLAIM_EDIT_EFFECT', 'DOCUMENTATION_REQUIREMENT_EFFECT'],
  TARIFF: ['PRICE_EFFECT', 'TARIFF_EFFECT', 'REIMBURSEMENT_EFFECT'],
  PROVIDER_CONTRACT: [
    'PRICE_EFFECT',
    'REIMBURSEMENT_EFFECT',
    'AUTHORIZATION_REQUIREMENT_EFFECT',
    'DOCUMENTATION_REQUIREMENT_EFFECT',
  ],
  PAYER_POLICY: [
    'CLAIM_EDIT_EFFECT',
    'REIMBURSEMENT_EFFECT',
    'AUTHORIZATION_REQUIREMENT_EFFECT',
    'ELIGIBILITY_REQUIREMENT_EFFECT',
    'DOCUMENTATION_REQUIREMENT_EFFECT',
  ],
  TPA_POLICY: [
    'CLAIM_EDIT_EFFECT',
    'AUTHORIZATION_REQUIREMENT_EFFECT',
    'ELIGIBILITY_REQUIREMENT_EFFECT',
    'DOCUMENTATION_REQUIREMENT_EFFECT',
  ],
  CLINICAL_STANDARD: [],
  RESEARCH_PUBLICATION: [],
  OPERATIONAL_GUIDANCE: [],
  OTHER: [],
}

// REFERENCE_ONLY may be associated with any source category, but this function is never
// consulted to grant REFERENCE_ONLY executable authority — callers must branch on effectType
// === 'REFERENCE_ONLY' before this, since REFERENCE_ONLY can never become POTENTIALLY_ALLOWED.
export function isCompatibleGoverningEffect(sourceCategory: string, effectType: string): boolean {
  if (effectType === 'REFERENCE_ONLY') return true
  const permitted = sourceCategoryPermittedEffects[sourceCategory]
  if (!permitted) return false
  return permitted.includes(effectType)
}
