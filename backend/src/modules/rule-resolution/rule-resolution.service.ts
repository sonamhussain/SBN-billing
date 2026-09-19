import {
  APPLICABILITY_DIMENSIONS_V2,
  type ApplicabilityContextV2,
  type ApplicabilityDimensionKeyV2,
} from '../../shared/rules/applicability-context-v2.ts'
import { normalizeOptionalUuidField } from '../rule-applicability/rule-applicability.validation.ts'
import { findRuleApplicabilitiesByVersionId } from '../rule-applicability/rule-applicability.repository.ts'
import { matchedApplicabilityIds } from '../rule-applicability/rule-applicability.matcher.ts'
import { validateApplicabilityContextCoherence } from '../rule-applicability/rule-applicability.context-coherence.ts'
import { resolveFacilityRegulatoryProfileForDate } from '../facility-regulatory/facility-regulatory.repository.ts'
import { formatDateOnly, normalizeBusinessDate } from '../rule-source-version/rule-source-version.validation.ts'
import { isEffective } from '../rule-source-version/rule-source-version.activation.ts'
import { evaluateExecutability } from '../rule-source-binding/rule-source-binding.service.ts'
import { evaluateGoverningCandidateBlockers } from '../rule-source-binding/rule-source-binding.candidate.ts'
import type { ScopeContext } from '../rule-source-scope/rule-source-scope.matcher.ts'
import {
  bestMatchedSpecificity,
  hasConflictAmong,
  highestSpecificityCandidates,
  precedencePolicyVersion,
  resolveSupersedesDominance,
  type SupersedesEdge,
} from './rule-resolution.precedence.ts'
import {
  findBindingsForResolution,
  findConflictEdgesAmong,
  findRuleDefinitionForResolution,
  findRuleVersionsForResolution,
  findSourceVersionEffectiveDates,
  findSupersedesEdgesTouching,
} from './rule-resolution.repository.ts'
import { isRuleResolutionUuid, resolutionContextKeys } from './rule-resolution.validation.ts'
import { isHistoricalOnlyReference, isHistoricalOnlyResolved } from './rule-resolution.currentness.ts'
import { utcDateOf } from '../../shared/rules/date-only.ts'
import type { ResolutionStatus, RuleResolutionDto, RuleResolutionResult } from './rule-resolution.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'

type BindingForResolution = Awaited<ReturnType<typeof findBindingsForResolution>>[number]

type ResponseParts = {
  status: ResolutionStatus
  ruleDefinitionId: string
  businessDate: string
  jurisdictionCode: string
  ruleVersionId?: string | null
  ruleVersion?: string | null
  winner?: BindingForResolution | null
  supportingBindingIds?: string[]
  matchedApplicabilityIds?: string[]
  specificityScore?: number | null
  historicalOnly?: boolean
  blockers?: string[]
}

function buildResponse(parts: ResponseParts): RuleResolutionDto {
  const winner = parts.winner ?? null
  return {
    resolutionStatus: parts.status,
    precedencePolicyVersion,
    ruleDefinitionId: parts.ruleDefinitionId,
    ruleVersionId: parts.ruleVersionId ?? null,
    ruleVersion: parts.ruleVersion ?? null,
    governingBindingId: winner?.id ?? null,
    governingSourceInterpretationId: winner?.sourceInterpretationId ?? null,
    governingSourceVersionId: winner?.sourceInterpretation.sourceVersion.id ?? null,
    governingSourceId: winner?.sourceInterpretation.sourceVersion.source.id ?? null,
    supportingBindingIds: parts.supportingBindingIds ?? [],
    matchedApplicabilityIds: parts.matchedApplicabilityIds ?? [],
    businessDate: parts.businessDate,
    jurisdictionCode: parts.jurisdictionCode,
    specificityScore: parts.specificityScore ?? null,
    historicalOnly: parts.historicalOnly ?? false,
    blockers: parts.blockers ?? [],
  }
}

// Walks the SUPERSEDES graph outwards from the candidate versions — in both directions — until
// no new version is reached, so a chain S3 -> S2 -> S1 is closed even when the intermediate S2
// is not itself a candidate, and so a successor that is not a candidate is still visible to the
// historical date rule. Read-only and bounded by the graph size (A3.4 guarantees it is acyclic).
async function collectSupersedesNeighbourhood(
  startIds: string[],
  db: DbClient,
): Promise<{ edges: SupersedesEdge[]; sourceVersionIds: string[] }> {
  const edges: SupersedesEdge[] = []
  const seenEdges = new Set<string>()
  const visited = new Set<string>()
  let frontier = [...new Set(startIds)]

  while (frontier.length > 0) {
    const fetched = await findSupersedesEdgesTouching(frontier, db)
    for (const id of frontier) visited.add(id)

    const next: string[] = []
    for (const edge of fetched) {
      const key = `${edge.fromSourceVersionId}->${edge.toSourceVersionId}`
      if (!seenEdges.has(key)) {
        seenEdges.add(key)
        edges.push(edge)
      }
      for (const id of [edge.fromSourceVersionId, edge.toSourceVersionId]) {
        if (!visited.has(id)) next.push(id)
      }
    }
    frontier = [...new Set(next)]
  }

  return { edges, sourceVersionIds: [...visited] }
}

// Internal seams only — the HTTP route never passes these. `clock` lets a test freeze the one
// evaluation timestamp; production always reads the server clock. `db` lets a future composed
// evaluation share its snapshot.
export type ResolutionInternalOptions = {
  clock?: () => Date
  // Reuse a caller's read snapshot instead of opening one (audit F04).
  db?: DbClient
}

const systemClock = () => new Date()

export async function evaluateRuleResolution(
  ruleDefinitionId: string,
  businessDateInput: unknown,
  contextInputs: Record<string, unknown>,
  internal: ResolutionInternalOptions = {},
): Promise<RuleResolutionResult<RuleResolutionDto>> {
  // Audit F02: one server timestamp, captured once per request before anything else, and never
  // taken from the client. evaluationDate is its UTC calendar date. It decides only the
  // historicalOnly metadata; businessDate alone decides what is selected.
  const evaluationDate = utcDateOf((internal.clock ?? systemClock)())
  if (!evaluationDate) throw new Error('rule resolution: the evaluation clock returned an invalid instant')

  if (!isRuleResolutionUuid(ruleDefinitionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule definition id' }

  const businessDate = normalizeBusinessDate(businessDateInput)
  if (!businessDate) return { ok: false, code: 'VALIDATION_ERROR', message: 'businessDate must be a YYYY-MM-DD date' }
  const businessDateText = formatDateOnly(businessDate) as string

  // Only the eleven client-suppliable dimensions are read from the body; the twelfth
  // (facilityRegulatoryProfileId) is server-derived below and any client value is ignored.
  const context: ApplicabilityContextV2 = {}
  for (const key of resolutionContextKeys) {
    const field = normalizeOptionalUuidField(contextInputs[key])
    if (!field.valid) return { ok: false, code: 'VALIDATION_ERROR', message: `${key} must be a valid UUID or null` }
    context[key] = field.value
  }

  // Audit F04: every read of this evaluation — rule definition, context coherence, facility
  // profile, rule versions, applicability, bindings, the reused A3.7 gate, candidate signals and
  // the SUPERSEDES/CONFLICTS_WITH graph — comes from ONE read-only REPEATABLE READ snapshot, the
  // same one A3.7 runs inside, so the response reflects one consistent state and never combines
  // facts from before and after a concurrent governance change. The evaluation instant above
  // (F02) is captured once for the same request.
  return withReadSnapshot(internal.db, async (tx) => {
      // A3.8 §9 step 1 — jurisdiction and ownership come from the RuleDefinition, never the request.
      const ruleDefinition = await findRuleDefinitionForResolution(ruleDefinitionId, tx)
      if (!ruleDefinition || ruleDefinition.organizationId === null)
        return { ok: false, code: 'NOT_FOUND', message: 'rule definition not found' }

      const ruleOrganizationId = ruleDefinition.organizationId
      const jurisdictionCode = ruleDefinition.jurisdictionCode

      // REF-01 §10: facilityRegulatoryProfileId is server-derived from facilityId + businessDate,
      // exactly as on A3.7's executability endpoint, so the two modules always see the same
      // regulatory context. It is never client-suppliable.
      context.facilityRegulatoryProfileId = null

      // Existence, tenancy and ancestry of the client-supplied facts first, so an unknown or foreign
      // facility keeps its 404/403 rather than being reported as a missing profile — the same order
      // A3.7 uses.
      const coherence = await validateApplicabilityContextCoherence(context, ruleOrganizationId, tx)
      if (!coherence.ok) return { ok: false, code: coherence.code, message: coherence.message }

      // Audit F05 (shared contract, F05-A): the one facility-profile resolver, with an explicit
      // zero/one/many result. A3.8 does not carry a second resolution helper. An explicitly supplied
      // facility needs exactly one ACTIVE profile in force on businessDate; none or several fails
      // closed here, before rule-version matching, the historical path or any REFERENCE_ONLY result.
      // Omitting facilityId remains a valid generic resolution.
      let resolvedProfile: { id: string; jurisdictionCode: string } | null = null
      if (context.facilityId) {
        const resolution = await resolveFacilityRegulatoryProfileForDate(context.facilityId, businessDate, tx)
        if (resolution.kind === 'none')
          return {
            ok: false,
            code: 'VALIDATION_ERROR',
            message: 'facilityId has no ACTIVE regulatory profile effective on businessDate',
          }
        if (resolution.kind === 'many')
          return {
            ok: false,
            code: 'VALIDATION_ERROR',
            message: 'facilityId has more than one ACTIVE regulatory profile effective on businessDate',
          }
        resolvedProfile = resolution.profile
        context.facilityRegulatoryProfileId = resolution.profile.id
      }

      // Internal pause points for the F04 snapshot proof; no-ops in production.
      await concurrencyProbe('rule_resolution.after_context')

      // A rule-level jurisdiction mismatch is not a "no longer current" condition, so it must never
      // be rescued by the historical path below — it is recorded here and consulted at that point.
      const profileJurisdictionMismatch =
        resolvedProfile !== null &&
        resolvedProfile.jurisdictionCode.trim().toUpperCase() !== jurisdictionCode.trim().toUpperCase()

      const baseParts = { ruleDefinitionId, businessDate: businessDateText, jurisdictionCode }

      // ---- A3.8 §9 steps 2-4: candidate RuleVersions --------------------------------------------
      const versions = await findRuleVersionsForResolution(ruleDefinitionId, tx)
      // The selected RuleVersion's real dates are kept on its candidate record (audit F02), so its
      // currentness is judged from its own period — never from a version label, a creation
      // timestamp, a successor or another rule.
      const versionCandidates: {
        id: string
        version: string
        effectType: string
        effectiveFrom: Date | null
        effectiveTo: Date | null
        specificityScore: number
        matchedApplicabilityIds: string[]
      }[] = []

      for (const version of versions) {
        if (version.verificationStatus !== 'VERIFIED') continue
        if (!isEffective(version.effectiveFrom, version.effectiveTo, businessDate)) continue

        const rows = await findRuleApplicabilitiesByVersionId(version.id, tx)
        const score = bestMatchedSpecificity(rows, context)
        if (score === null) continue

        versionCandidates.push({
          id: version.id,
          version: version.version,
          effectType: version.effectType,
          effectiveFrom: version.effectiveFrom,
          effectiveTo: version.effectiveTo,
          specificityScore: score,
          matchedApplicabilityIds: matchedApplicabilityIds(rows, context),
        })
      }

      // A3.8 §9 step 3 — nothing verified, effective and applicable on this date.
      if (versionCandidates.length === 0) {
        return { ok: true, value: buildResponse({ ...baseParts, status: 'NO_MATCH' }) }
      }

      // A3.8 §9 step 5 / §11 — keep the most specific, and block rather than break a tie. Version
      // string, createdAt, updatedAt and effectiveFrom are deliberately never consulted here.
      const mostSpecific = highestSpecificityCandidates(versionCandidates)
      if (mostSpecific.length > 1) {
        return {
          ok: true,
          value: buildResponse({
            ...baseParts,
            status: 'BLOCKED_RULE_VERSION_CONFLICT',
            specificityScore: mostSpecific[0].specificityScore,
            blockers: ['RULE_VERSION_SPECIFICITY_TIE'],
          }),
        }
      }

      const selected = mostSpecific[0]
      const selectedParts = {
        ...baseParts,
        ruleVersionId: selected.id,
        ruleVersion: selected.version,
        matchedApplicabilityIds: selected.matchedApplicabilityIds,
        specificityScore: selected.specificityScore,
      }

      // A3.8 §9 step 6 — a reference-only rule never reaches source precedence.
      //
      // Audit F05-B: being non-executable does not make an incorrect regulatory context truthful. A
      // facility whose resolved profile is in a different jurisdiction from the rule must not produce
      // a clean REFERENCE_ONLY answer. This is the same outcome A3.8 already gives the identical
      // mismatch on an executable rule (via A3.7's rule-level JURISDICTION_INCOMPATIBLE), so one
      // condition has one answer whatever the rule's effect type — no new status or blocker code.
      if (selected.effectType === 'REFERENCE_ONLY') {
        if (profileJurisdictionMismatch) {
          return {
            ok: true,
            value: buildResponse({ ...selectedParts, status: 'BLOCKED_EXECUTABILITY', blockers: ['JURISDICTION_INCOMPATIBLE'] }),
          }
        }
        return {
          ok: true,
          value: buildResponse({
            ...selectedParts,
            status: 'REFERENCE_ONLY',
            // Audit F02: a reference-only rule no longer in force today is a non-current reference.
            historicalOnly: isHistoricalOnlyReference(selected, evaluationDate),
          }),
        }
      }

      const bindings = await findBindingsForResolution(selected.id, tx)
      const supportingBindingIds = bindings.filter((binding) => binding.sourceRole === 'SUPPORTING').map((binding) => binding.id)
      const withSupporting = { ...selectedParts, supportingBindingIds }

      // ---- A3.8 §9 step 7: reuse A3.7's gate verbatim -------------------------------------------
      const executabilityInputs = {} as Record<ApplicabilityDimensionKeyV2, unknown>
      for (const key of APPLICABILITY_DIMENSIONS_V2) executabilityInputs[key] = context[key] ?? null

      const executability = await evaluateExecutability(selected.id, businessDateText, executabilityInputs, { db: tx })
      if (!executability.ok) return { ok: false, code: executability.code, message: executability.message }
      await concurrencyProbe('rule_resolution.after_gate')

      const scopeContext: ScopeContext = {
        facilityId: context.facilityId ?? null,
        payerId: context.payerId ?? null,
        tpaId: context.tpaId ?? null,
        networkId: context.networkId ?? null,
        insuranceProductId: context.insuranceProductId ?? null,
        providerContractId: context.providerContractId ?? null,
        tariffScheduleId: context.tariffScheduleId ?? null,
        tariffScheduleVersionId: context.tariffScheduleVersionId ?? null,
      }

      // ---- A3.8 §9 step 8 + §13: the complete as-of governing candidate set ---------------------
      //
      // Audit F03: every GOVERNING binding is evaluated with the shared per-candidate gate in
      // HISTORICAL mode, so the set holds ALL eligible ACTIVE and SUPERSEDED candidates for this
      // businessDate before dominance and conflict resolution. HISTORICAL differs from A3.7's
      // CURRENT admission by exactly one rule - a SUPERSEDED version may still answer for a date it
      // governed - and relaxes nothing else (ownership, jurisdiction, verification, publication,
      // effective dates, dependency, conflict, effect compatibility, typed scope), so CURRENT's
      // candidates are always a subset of these.
      //
      // Previously HISTORICAL candidates were considered only when A3.7's CURRENT gate had found no
      // ACTIVE candidate at all, so one valid ACTIVE source silently shut out a valid SUPERSEDED one
      // and stored current status became an accidental winner preference. Only the approved
      // SUPERSEDES/date rule below may now make one candidate prevail over another.
      //
      // A3.7's own current admission stays ACTIVE-only; this resolver is a reference resolver, not
      // that execution gate.
      //
      // A rule-level jurisdiction mismatch is not a "no longer current" condition, so it never
      // produces candidates here.
      const candidateBindings: BindingForResolution[] = []

      if (!profileJurisdictionMismatch) {
        for (const binding of bindings) {
          if (binding.sourceRole !== 'GOVERNING') continue
          const blockers = await evaluateGoverningCandidateBlockers(binding.sourceInterpretation, {
            ruleOrganizationId,
            ruleJurisdictionCode: jurisdictionCode,
            ruleEffectType: selected.effectType,
            businessDate,
            scopeContext,
            mode: 'HISTORICAL',
            db: tx,
          })
          if (blockers.size === 0) candidateBindings.push(binding)
        }
      }

      if (candidateBindings.length === 0) {
        return {
          ok: true,
          value: buildResponse({
            ...withSupporting,
            status: 'BLOCKED_EXECUTABILITY',
            blockers: executability.value.blockers,
          }),
        }
      }

      // ---- A3.8 §9 steps 9-15: source precedence ------------------------------------------------
      await concurrencyProbe('rule_resolution.before_graph')
      const candidateSourceVersionIds = candidateBindings.map((binding) => binding.sourceInterpretation.sourceVersion.id)

      const neighbourhood = await collectSupersedesNeighbourhood(candidateSourceVersionIds, tx)
      const neighbourhoodVersions = await findSourceVersionEffectiveDates(neighbourhood.sourceVersionIds, tx)
      const precedenceVersions = neighbourhoodVersions.map((version) => ({
        sourceVersionId: version.id,
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
      }))

      const dominance = resolveSupersedesDominance(
        candidateSourceVersionIds,
        precedenceVersions,
        neighbourhood.edges,
        businessDate,
      )

      if (!dominance.ok) {
        return {
          ok: true,
          value: buildResponse({
            ...withSupporting,
            status: 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
            blockers: [dominance.blocker],
          }),
        }
      }

      const survivingIds = dominance.survivingSourceVersionIds
      const conflictEdges = await findConflictEdgesAmong(survivingIds, tx)
      if (hasConflictAmong(survivingIds, conflictEdges)) {
        return {
          ok: true,
          value: buildResponse({
            ...withSupporting,
            status: 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
            blockers: ['SOURCE_CONFLICT'],
          }),
        }
      }

      const survivors = candidateBindings.filter((binding) =>
        survivingIds.includes(binding.sourceInterpretation.sourceVersion.id),
      )

      // Exactly one surviving candidate resolves. Anything else blocks — including the defensive
      // zero case, which an acyclic graph should make unreachable.
      if (survivors.length !== 1) {
        return {
          ok: true,
          value: buildResponse({
            ...withSupporting,
            status: 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
            blockers: ['SOURCE_PRECEDENCE_TIE'],
          }),
        }
      }

      const winner = survivors[0]

      return {
        ok: true,
        value: buildResponse({
          ...withSupporting,
          status: 'RESOLVED',
          winner,
          // Provenance, not permission (A3.8 §13). Audit F02: an answer is historical when the
          // selected RuleVersion is not in force on evaluationDate, or the winning source version is
          // not ACTIVE, or it is not in force on evaluationDate. Stored ACTIVE status alone used to
          // decide this, so an expired rule or an expired-but-still-ACTIVE source read as current.
          historicalOnly: isHistoricalOnlyResolved(selected, winner.sourceInterpretation.sourceVersion, evaluationDate),
        }),
      }
  })
}
