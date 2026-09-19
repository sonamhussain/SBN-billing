import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityContextV2 } from '../../shared/rules/applicability-context-v2.ts'
import { isValidInstant, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import { isWithinPackPeriod, jurisdictionsMatch } from '../rule-pack/rule-pack.validation.ts'
import type { RuleResolutionDto } from '../rule-resolution/rule-resolution.types.ts'
import type { ProvenanceCompositionError, ProvenanceContext } from './rule-provenance.types.ts'

// A3.9 — the pure core of the internal A3-PROV-1 composer: the input gate, the context copy and
// the pack-version usability rule. No database access, so it is unit-testable on its own; the
// composer (rule-provenance.composer.ts) adds only exact-ID lookups around it.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSbnUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

// All twelve ApplicabilityContextV2 dimensions, exactly as the authoritative context carried them;
// a dimension that was not supplied or derived is null. A snapshot copy, never a matcher.
export function toProvenanceContext(context: ApplicabilityContextV2): ProvenanceContext {
  const out = {} as ProvenanceContext
  for (const key of APPLICABILITY_DIMENSIONS_V2) out[key] = context[key] ?? null
  return out
}

export type WinnerFields = {
  ruleVersionId: string
  ruleVersion: string
  governingBindingId: string
  governingSourceInterpretationId: string
  governingSourceVersionId: string
  governingSourceId: string
}

export type PrecheckedInput = {
  fields: WinnerFields
  businessDate: Date
  rulePackVersionId: string | null
}

// Step 1 and the input invariants, before any lookup. Only a RESOLVED A3.8 result produces
// provenance; a RESOLVED result missing a winner ID, a non-UUID organization, an invalid
// evaluation instant or an unparseable businessDate fails closed — nothing is filled in by guessing.
// The trusted evaluation fields the gate needs (read from the A3.8 bundle registry by the composer).
export type EvaluationForPrecheck = {
  resolution: RuleResolutionDto
  organizationId: string
  evaluationTimestamp: Date
}

export function precheckProvenanceInput(
  input: EvaluationForPrecheck & { rulePackVersionId?: string | null },
): { ok: true; value: PrecheckedInput } | { ok: false; error: ProvenanceCompositionError } {
  const resolution: RuleResolutionDto = input.resolution
  if (resolution.resolutionStatus !== 'RESOLVED')
    return {
      ok: false,
      error: {
        code: 'RESOLUTION_NOT_RESOLVED',
        message: `the A3.8 result is ${resolution.resolutionStatus}, not RESOLVED; no provenance is produced`,
      },
    }

  const candidate = {
    ruleVersionId: resolution.ruleVersionId,
    ruleVersion: resolution.ruleVersion,
    governingBindingId: resolution.governingBindingId,
    governingSourceInterpretationId: resolution.governingSourceInterpretationId,
    governingSourceVersionId: resolution.governingSourceVersionId,
    governingSourceId: resolution.governingSourceId,
  }
  const missing = Object.entries(candidate)
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([key]) => key)
  if (missing.length > 0)
    return { ok: false, error: { code: 'PROVENANCE_INVARIANT_VIOLATION', message: `the RESOLVED result is missing ${missing.join(', ')}` } }

  const idFields = ['ruleVersionId', 'governingBindingId', 'governingSourceInterpretationId', 'governingSourceVersionId', 'governingSourceId'] as const
  const notUuid = idFields.filter((key) => !isSbnUuid(candidate[key]))
  if (!isSbnUuid(resolution.ruleDefinitionId) || notUuid.length > 0)
    return { ok: false, error: { code: 'PROVENANCE_INVARIANT_VIOLATION', message: 'an authoritative ID in the RESOLVED result is not an SBN UUID' } }
  const otherIds = [...resolution.supportingBindingIds, ...resolution.matchedApplicabilityIds]
  if (!otherIds.every(isSbnUuid))
    return { ok: false, error: { code: 'PROVENANCE_INVARIANT_VIOLATION', message: 'a supporting binding or applicability ID is not an SBN UUID' } }

  if (!isSbnUuid(input.organizationId))
    return { ok: false, error: { code: 'PROVENANCE_INVARIANT_VIOLATION', message: 'organizationId is not an SBN UUID' } }
  if (!isValidInstant(input.evaluationTimestamp))
    return { ok: false, error: { code: 'PROVENANCE_INVARIANT_VIOLATION', message: 'evaluationTimestamp is not a valid instant' } }
  const businessDate = parseStrictDateOnly(resolution.businessDate)
  if (!businessDate)
    return { ok: false, error: { code: 'PROVENANCE_INVARIANT_VIOLATION', message: 'the resolution businessDate is not a YYYY-MM-DD date' } }

  const rulePackVersionId = input.rulePackVersionId ?? null
  if (rulePackVersionId !== null && !isSbnUuid(rulePackVersionId))
    return { ok: false, error: { code: 'PACK_VERSION_NOT_USABLE', message: 'rulePackVersionId is not an SBN UUID' } }

  return { ok: true, value: { fields: candidate as WinnerFields, businessDate, rulePackVersionId } }
}

type PackVersionForUse = {
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  activationStatus: string
  rulePack: { organizationId: string | null; jurisdictionCode: string }
}

// A supplied exact RulePackVersion may be referenced only when it is a governed snapshot for this
// decision:
// - ownership: the organization's own pack, or a SYSTEM_SHARED one;
// - jurisdiction: matches the resolved rule's jurisdiction (normalized trim/case);
// - verification: VERIFIED;
// - lifecycle: it has governed — ACTIVE, or SUPERSEDED for history. A VERIFIED snapshot that was
//   never activated has governed nothing, so it is not usable (fail closed);
// - effective dates: businessDate falls inside the pack version's own period when dates exist.
export type PackUsability = { usable: true } | { usable: false; reason: string }

export function decidePackVersionUsable(
  packVersion: PackVersionForUse,
  decision: { organizationId: string; jurisdictionCode: string; businessDate: Date },
): PackUsability {
  const packOrganizationId = packVersion.rulePack.organizationId
  if (packOrganizationId !== null && packOrganizationId !== decision.organizationId)
    return { usable: false, reason: 'the rule pack belongs to a different organization' }
  if (!jurisdictionsMatch(packVersion.rulePack.jurisdictionCode, decision.jurisdictionCode))
    return { usable: false, reason: 'the rule pack jurisdiction does not match the resolved rule jurisdiction' }
  if (packVersion.verificationStatus !== 'VERIFIED') return { usable: false, reason: 'the rule pack version is not VERIFIED' }
  if (packVersion.activationStatus !== 'ACTIVE' && packVersion.activationStatus !== 'SUPERSEDED')
    return { usable: false, reason: 'the rule pack version has never been ACTIVE, so it has governed nothing' }
  if (!isWithinPackPeriod(packVersion, decision.businessDate))
    return { usable: false, reason: 'businessDate is outside the rule pack version effective period' }
  return { usable: true }
}
