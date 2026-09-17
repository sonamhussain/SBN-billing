import { evaluateActivationBlockers } from '../rule-source-version/rule-source-version.activation.ts'
import { computeActivationRelationshipSignals } from '../rule-source-relationship/rule-source-relationship.service.ts'
import { findRuleSourceScopesBySourceId } from '../rule-source-scope/rule-source-scope.repository.ts'
import { matchedScopeRows, type ScopeContext } from '../rule-source-scope/rule-source-scope.matcher.ts'
import { categoryMinimumScopeSatisfied, categoryRequiresScope } from '../rule-source-scope/rule-source-scope.validation.ts'
import { isCompatibleGoverningEffect } from './rule-source-binding.compatibility.ts'
import { toExecutabilityBlockerCodes } from './rule-source-binding.validation.ts'

// The per-candidate governing checks of A3.7's executability gate, extracted from the service so
// the logic lives in one place and can be reused rather than copied by later modules.

export type CandidateSourceVersion = {
  id: string
  publicationStatus: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  activationStatus: string
  source: {
    id: string
    organizationId: string | null
    jurisdictionCode: string
    sourceCategory: string
  }
}

export type CandidateInterpretation = {
  verificationStatus: string
  sourceVersion: CandidateSourceVersion
}

export type GoverningCandidateParams = {
  ruleOrganizationId: string
  ruleJurisdictionCode: string
  ruleEffectType: string
  businessDate: Date
  scopeContext: ScopeContext
}

// Returns the blocker codes for one GOVERNING candidate. An empty set means the candidate passed
// every gate; it never mutates anything and never writes an AuditEvent.
export async function evaluateGoverningCandidateBlockers(
  interpretation: CandidateInterpretation,
  params: GoverningCandidateParams,
): Promise<Set<string>> {
  const sourceVersion = interpretation.sourceVersion
  const source = sourceVersion.source
  const sourceOrgId = source.organizationId

  const bindingBlockers = new Set<string>()

  // Ownership is already enforced at binding-create time, but re-checked here defensively —
  // SYSTEM_SHARED (null org) is always allowed to govern a tenant rule.
  const ownershipOk = sourceOrgId === null || sourceOrgId === params.ruleOrganizationId
  if (!ownershipOk) bindingBlockers.add('OWNERSHIP_MISMATCH')

  // Stored activation status alone is not trusted — see the live re-evaluation below, which
  // can surface a new dependency/conflict even though activationStatus still reads ACTIVE.
  if (sourceVersion.activationStatus !== 'ACTIVE') bindingBlockers.add('SOURCE_NOT_ACTIVE')

  const relationshipSignals = await computeActivationRelationshipSignals(sourceVersion.id)
  // Passing [interpretation] (not the full interpretation list) makes the reused evaluator's
  // "any interpretation verified" check become "the exact bound interpretation is verified" —
  // per A3.7's explicit rule: verify the bound interpretation, never "any" interpretation.
  const liveBlockers = evaluateActivationBlockers(
    sourceVersion,
    { jurisdictionCode: source.jurisdictionCode, organizationId: sourceOrgId },
    [interpretation],
    { businessDate: params.businessDate, jurisdictionCode: params.ruleJurisdictionCode, requestingOrganizationId: sourceOrgId },
    relationshipSignals,
  )
  for (const code of toExecutabilityBlockerCodes(liveBlockers)) bindingBlockers.add(code)

  if (!isCompatibleGoverningEffect(source.sourceCategory, params.ruleEffectType)) {
    bindingBlockers.add('SOURCE_EFFECT_INCOMPATIBLE')
  }

  // REF-01 / R6: PAYER_POLICY/TPA_POLICY/PROVIDER_CONTRACT/TARIFF sources must prove — via a
  // typed RuleSourceScope row — which specific payer/TPA/contract/tariff they govern. Zero
  // scope rows or no matching row both fail closed; categories that never need scope skip this.
  if (categoryRequiresScope(source.sourceCategory)) {
    const scopeRows = await findRuleSourceScopesBySourceId(source.id)
    const matchedRows = matchedScopeRows(scopeRows, params.scopeContext)
    const satisfiesMinimum = matchedRows.length > 0 && categoryMinimumScopeSatisfied(source.sourceCategory, matchedRows)
    if (!satisfiesMinimum) {
      bindingBlockers.add('SOURCE_CONTEXT_INCOMPATIBLE')
    }
  }

  return bindingBlockers
}
