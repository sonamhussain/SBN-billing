// FE-05 — the owner-defined A3.5 effect types a rule version may carry. Metadata only: choosing one never
// executes, prices or decides anything in the frontend.
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
