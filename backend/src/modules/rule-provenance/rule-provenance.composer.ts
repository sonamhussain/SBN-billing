import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { jurisdictionsMatch } from '../rule-pack/rule-pack.validation.ts'
import { readIssuedEvaluation } from '../rule-resolution/rule-resolution.bundle.ts'
import {
  findApplicabilitiesForProvenance,
  findBindingsForProvenance,
  findExactPackMembership,
  findRulePackVersionForProvenance,
  findRuleVersionForProvenance,
} from './rule-provenance.repository.ts'
import { decidePackVersionUsable, precheckProvenanceInput, toProvenanceContext } from './rule-provenance.validation.ts'
import {
  provenanceContractVersion,
  type ComposeProvenanceInput,
  type ProvenanceCompositionErrorCode,
  type ProvenanceResult,
  type RuleDecisionProvenanceRefV1,
} from './rule-provenance.types.ts'

// A3.9 §14 — the INTERNAL A3-PROV-1 composer. There is no route, no permission and no frontend for
// it (A3.9 v1.1 removed the public provenance surface as a duplicate of A3.8).
//
// It answers only: "given this authoritative A3.8 RESOLVED result, which exact governed references
// must later be preserved?" It never asks A3.8's question again: it runs no specificity, no
// SUPERSEDES/CONFLICTS_WITH precedence, no A3.7 compatibility gate and no facility-profile
// resolution. Every ID is copied from the A3.8 result and then proven by exact-ID lookup only, so
// a forged or inconsistent input fails closed instead of producing provenance. It writes no row
// and no AuditEvent.

function fail(code: ProvenanceCompositionErrorCode, message: string): ProvenanceResult {
  return { ok: false, error: { code, message } }
}

export async function composeRuleDecisionProvenanceRefV1(
  input: ComposeProvenanceInput,
  // Internal: reuse a caller's read snapshot (audit F04). Otherwise one read-only snapshot is
  // opened here, so every lookup below sees one consistent state.
  db?: DbClient,
): Promise<ProvenanceResult> {
  // A3.9 v1.2 — only a bundle issued by ONE A3.8 evaluation is accepted, and its fields are read
  // from the resolver's private record, not from the object passed in. A bundle spliced together
  // from two evaluations (or hand-built with the same values) is not an issued bundle.
  const evaluation = readIssuedEvaluation(input.evaluation)
  if (!evaluation)
    return fail('PROVENANCE_INVARIANT_VIOLATION', 'the evaluation is not an unmodified bundle issued by one A3.8 resolution')

  // Step 1 and input invariants (pure, before any lookup).
  const prechecked = precheckProvenanceInput({ ...evaluation, rulePackVersionId: input.rulePackVersionId })
  if (!prechecked.ok) return prechecked
  const { fields, businessDate, rulePackVersionId } = prechecked.value
  const { resolution, organizationId, authoritativeContext, evaluationTimestamp } = evaluation

  return withReadSnapshot(db, async (tx) => {
    // Steps 2–5 — the exact rule, source, binding and applicability IDs are copied from A3.8, then
    // each one is proven by exact-ID lookup. These are consistency checks, not resolution.
    const ruleVersion = await findRuleVersionForProvenance(fields.ruleVersionId, tx)
    if (!ruleVersion) return fail('PROVENANCE_INVARIANT_VIOLATION', 'the resolved RuleVersion does not exist')
    if (ruleVersion.ruleId !== resolution.ruleDefinitionId)
      return fail('PROVENANCE_INVARIANT_VIOLATION', 'the resolved RuleVersion does not belong to the resolved RuleDefinition')
    if (ruleVersion.version !== fields.ruleVersion)
      return fail('PROVENANCE_INVARIANT_VIOLATION', 'the resolved RuleVersion label does not match the stored version')
    if (ruleVersion.rule.organizationId !== organizationId)
      return fail('PROVENANCE_INVARIANT_VIOLATION', 'the resolved rule does not belong to the supplied organization')
    if (!jurisdictionsMatch(ruleVersion.rule.jurisdictionCode, resolution.jurisdictionCode))
      return fail('PROVENANCE_INVARIANT_VIOLATION', 'the resolution jurisdiction does not match the rule definition')

    const bindingIds = [fields.governingBindingId, ...resolution.supportingBindingIds]
    const bindings = new Map((await findBindingsForProvenance(bindingIds, tx)).map((binding) => [binding.id, binding]))

    // Step 12 — the governing SourceVersion, by the exact governing binding. Never "latest".
    const governing = bindings.get(fields.governingBindingId)
    if (
      !governing ||
      governing.ruleVersionId !== fields.ruleVersionId ||
      governing.sourceRole !== 'GOVERNING' ||
      governing.sourceInterpretationId !== fields.governingSourceInterpretationId ||
      governing.sourceInterpretation.sourceVersionId !== fields.governingSourceVersionId ||
      governing.sourceInterpretation.sourceVersion.sourceId !== fields.governingSourceId
    )
      return fail('PROVENANCE_INVARIANT_VIOLATION', 'the governing binding, interpretation, source version and source do not reconstruct exactly')

    // Step 13 — supporting SourceVersion IDs, derived only from the exact supporting bindings, in
    // the order A3.8 reported them.
    const supportingSourceVersionIds: string[] = []
    for (const bindingId of resolution.supportingBindingIds) {
      const binding = bindings.get(bindingId)
      if (!binding || binding.ruleVersionId !== fields.ruleVersionId || binding.sourceRole !== 'SUPPORTING')
        return fail('PROVENANCE_INVARIANT_VIOLATION', `supporting binding ${bindingId} does not reconstruct exactly`)
      const sourceVersionId = binding.sourceInterpretation.sourceVersionId
      if (!supportingSourceVersionIds.includes(sourceVersionId)) supportingSourceVersionIds.push(sourceVersionId)
    }

    const applicabilities = await findApplicabilitiesForProvenance(resolution.matchedApplicabilityIds, tx)
    const applicabilityOwners = new Map(applicabilities.map((row) => [row.id, row.ruleVersionId]))
    for (const applicabilityId of resolution.matchedApplicabilityIds) {
      if (applicabilityOwners.get(applicabilityId) !== fields.ruleVersionId)
        return fail('PROVENANCE_INVARIANT_VIOLATION', `matched applicability ${applicabilityId} does not belong to the resolved RuleVersion`)
    }

    // Steps 9–11 — the optional exact pack version.
    let pack: { rulePackId: string | null; rulePackVersionId: string | null; rulePackVersion: string | null } = {
      rulePackId: null,
      rulePackVersionId: null,
      rulePackVersion: null,
    }
    if (rulePackVersionId !== null) {
      const packVersion = await findRulePackVersionForProvenance(rulePackVersionId, tx)
      if (!packVersion) return fail('PACK_VERSION_NOT_USABLE', 'the supplied rule pack version does not exist')
      const usability = decidePackVersionUsable(packVersion, {
        organizationId: organizationId,
        jurisdictionCode: resolution.jurisdictionCode,
        businessDate,
      })
      if (!usability.usable) return fail('PACK_VERSION_NOT_USABLE', usability.reason)
      const membership = await findExactPackMembership(rulePackVersionId, fields.ruleVersionId, tx)
      if (!membership)
        return fail('PACK_MEMBERSHIP_MISMATCH', 'the resolved RuleVersion is not an exact member of the supplied rule pack version')
      pack = { rulePackId: packVersion.rulePack.id, rulePackVersionId: packVersion.id, rulePackVersion: packVersion.version }
    }

    const provenance: RuleDecisionProvenanceRefV1 = {
      provenanceContractVersion,
      // Step 6 — verbatim from A3.8; the composer holds no policy literal of its own.
      precedencePolicyVersion: resolution.precedencePolicyVersion,
      ruleDefinitionId: resolution.ruleDefinitionId,
      ruleVersionId: fields.ruleVersionId,
      ruleVersion: fields.ruleVersion,
      ...pack,
      governingBindingId: fields.governingBindingId,
      governingSourceId: fields.governingSourceId,
      governingSourceVersionId: fields.governingSourceVersionId,
      governingSourceVersion: governing.sourceInterpretation.sourceVersion.version,
      governingSourceInterpretationId: fields.governingSourceInterpretationId,
      supportingBindingIds: [...resolution.supportingBindingIds],
      supportingSourceVersionIds,
      matchedApplicabilityIds: [...resolution.matchedApplicabilityIds],
      organizationId: organizationId,
      jurisdictionCode: resolution.jurisdictionCode,
      // Steps 7–8 — the authoritative context the A3.8 evaluation used; never re-resolved here.
      context: toProvenanceContext(authoritativeContext),
      // Step 14 — A3.8 consumed no ReferenceDatasetVersion, so none is claimed.
      referenceDatasetVersionIds: [],
      businessDate: resolution.businessDate,
      evaluationTimestamp: evaluationTimestamp.toISOString(),
      // Step 15 — copied exactly; never recalculated or downgraded. It is the A3.8 RuleVersion/source
      // currentness flag: a historical (SUPERSEDED) pack version never changes it.
      historicalOnly: resolution.historicalOnly,
    }
    return { ok: true, value: provenance }
  })
}
