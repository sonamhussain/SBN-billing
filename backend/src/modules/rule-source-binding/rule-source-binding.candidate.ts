import { evaluateActivationBlockers } from '../rule-source-version/rule-source-version.activation.ts'
import { computeActivationRelationshipSignals } from '../rule-source-relationship/rule-source-relationship.service.ts'
import { findRuleSourceScopesBySourceId } from '../rule-source-scope/rule-source-scope.repository.ts'
import { matchedScopeRows, type ScopeContext } from '../rule-source-scope/rule-source-scope.matcher.ts'
import { categoryMinimumScopeSatisfied, categoryRequiresScope } from '../rule-source-scope/rule-source-scope.validation.ts'
import { isCompatibleGoverningEffect } from './rule-source-binding.compatibility.ts'
import { toExecutabilityBlockerCodes } from './rule-source-binding.validation.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// The per-candidate governing checks of A3.7's executability gate, extracted from the service so
// the logic lives in one place and can be reused rather than copied by later modules.
//
// A3.8 §14 reuses this exact logic instead of copying A3.7's orchestration. A3.7 calls it with
// mode 'CURRENT', which is byte-for-byte the behaviour it had before A3.8 existed.
//
// CURRENT    — a governing source version must be ACTIVE right now (A3.7's safety gate).
// HISTORICAL — a version that has since been SUPERSEDED may still be evaluated, because it can
//              have been the applicable version for a past businessDate (A3.8 §13). Every other
//              check (publication, effective dates, verification, jurisdiction, ownership,
//              dependency, conflict, effect compatibility, typed scope) is unchanged, so a
//              historical candidate is never held to a weaker standard than a current one.
//
// Upstream A3.3 blocker codes are translated only through toExecutabilityBlockerCodes (audit F01),
// which fails closed on anything unmapped. A3.8 carries no alias table of its own.
export type CandidateEvaluationMode = 'CURRENT' | 'HISTORICAL'

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

// Internal test seam (never reachable from an HTTP route): lets a live test inject an upstream
// evaluator that returns a blocker A3.7 has never seen, to prove the real candidate path fails closed.
export type ActivationEvaluator = (...args: Parameters<typeof evaluateActivationBlockers>) => readonly unknown[]

export type CandidateInternalOptions = {
  activationEvaluator?: ActivationEvaluator
}

export type GoverningCandidateParams = {
  ruleOrganizationId: string
  ruleJurisdictionCode: string
  ruleEffectType: string
  businessDate: Date
  scopeContext: ScopeContext
  mode: CandidateEvaluationMode
  // Audit F04: the caller's read snapshot. Required, never defaulted, so a candidate check can
  // never silently read outside the evaluation's snapshot through the global client.
  db: DbClient
}

function activationAcceptable(activationStatus: string, mode: CandidateEvaluationMode): boolean {
  if (activationStatus === 'ACTIVE') return true
  return mode === 'HISTORICAL' && activationStatus === 'SUPERSEDED'
}

// Returns the blocker codes for one GOVERNING candidate. An empty set means the candidate passed
// every gate; it never mutates anything and never writes an AuditEvent.
export async function evaluateGoverningCandidateBlockers(
  interpretation: CandidateInterpretation,
  params: GoverningCandidateParams,
  internal: CandidateInternalOptions = {},
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
  if (!activationAcceptable(sourceVersion.activationStatus, params.mode)) bindingBlockers.add('SOURCE_NOT_ACTIVE')

  const relationshipSignals = await computeActivationRelationshipSignals(sourceVersion.id, params.db)
  // Passing [interpretation] (not the full interpretation list) makes the reused evaluator's
  // "any interpretation verified" check become "the exact bound interpretation is verified" —
  // per A3.7's explicit rule: verify the bound interpretation, never "any" interpretation.
  const evaluateActivation: ActivationEvaluator = internal.activationEvaluator ?? evaluateActivationBlockers
  const liveBlockers = evaluateActivation(
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
    const scopeRows = await findRuleSourceScopesBySourceId(source.id, params.db)
    const matchedRows = matchedScopeRows(scopeRows, params.scopeContext)
    const satisfiesMinimum = matchedRows.length > 0 && categoryMinimumScopeSatisfied(source.sourceCategory, matchedRows)
    if (!satisfiesMinimum) {
      bindingBlockers.add('SOURCE_CONTEXT_INCOMPATIBLE')
    }
  }

  return bindingBlockers
}
