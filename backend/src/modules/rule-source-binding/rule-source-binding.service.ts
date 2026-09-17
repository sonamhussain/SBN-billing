import { findRuleVersionWithOrganization } from '../rule-version/rule-version.repository.ts'
import { findRuleApplicabilitiesByVersionId } from '../rule-applicability/rule-applicability.repository.ts'
import { applicabilityDimensionKeys, normalizeOptionalUuidField, type ApplicabilityDimensionKey } from '../rule-applicability/rule-applicability.validation.ts'
import { matchedApplicabilityIds, ruleVersionMatches, type ApplicabilityContext } from '../rule-applicability/rule-applicability.matcher.ts'
import { validateApplicabilityContextCoherence } from '../rule-applicability/rule-applicability.context-coherence.ts'
import { normalizeBusinessDate } from '../rule-source-version/rule-source-version.validation.ts'
import { isEffective } from '../rule-source-version/rule-source-version.activation.ts'
import { compatibilityPolicyVersion, isCompatibleGoverningEffect } from './rule-source-binding.compatibility.ts'
import { evaluateGoverningCandidateBlockers, type CandidateInternalOptions } from './rule-source-binding.candidate.ts'
import { resolveFacilityRegulatoryProfileForDate } from '../facility-regulatory/facility-regulatory.repository.ts'
import type { ScopeContext } from '../rule-source-scope/rule-source-scope.matcher.ts'
import { isRuleSourceBindingUuid, normalizeSourceRole } from './rule-source-binding.validation.ts'
import type {
  ExecutabilityEvaluationDto,
  ExecutabilityGateStatus,
  RuleSourceBindingDto,
  RuleSourceBindingResult,
} from './rule-source-binding.types.ts'
import {
  createRuleSourceBindingRecord,
  findRuleSourceBindingById,
  findRuleSourceBindingsByRuleVersionId,
  findRuleSourceBindingsForEvaluation,
  findRuleVersionForExecutability,
  findSourceInterpretationForBinding,
} from './rule-source-binding.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleSourceBindingAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleSourceBindingRecord = {
  id: string
  ruleVersionId: string
  sourceInterpretationId: string
  sourceRole: string
  createdAt: Date
}

function toDto(record: RuleSourceBindingRecord): RuleSourceBindingDto {
  return {
    id: record.id,
    ruleVersionId: record.ruleVersionId,
    sourceInterpretationId: record.sourceInterpretationId,
    sourceRole: record.sourceRole,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createRuleSourceBinding(
  ruleVersionId: string,
  sourceInterpretationIdInput: unknown,
  sourceRoleInput: unknown,
  actorUserId: string,
): Promise<RuleSourceBindingResult<RuleSourceBindingDto>> {
  if (!isRuleSourceBindingUuid(ruleVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  if (typeof sourceInterpretationIdInput !== 'string' || !isRuleSourceBindingUuid(sourceInterpretationIdInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'sourceInterpretationId must be a valid UUID' }
  const sourceInterpretationId = sourceInterpretationIdInput

  const sourceRole = normalizeSourceRole(sourceRoleInput)
  if (!sourceRole) return { ok: false, code: 'VALIDATION_ERROR', message: 'sourceRole must be GOVERNING or SUPPORTING' }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const version = await findRuleVersionWithOrganization(ruleVersionId, tx)
      if (!version) return { kind: 'not_found' as const, message: 'rule version not found' }

      const ruleOrgId = version.rule.organizationId
      // Defense-in-depth: the route's own permission middleware already 404s a SYSTEM_SHARED
      // parent (null organizationId) before this service is ever reached.
      if (ruleOrgId === null) return { kind: 'not_found' as const, message: 'rule version not found' }

      if (version.verificationStatus === 'REJECTED')
        return { kind: 'terminal' as const, message: 'rule version is REJECTED and cannot accept new source bindings' }

      const interpretation = await findSourceInterpretationForBinding(sourceInterpretationId, tx)
      if (!interpretation) return { kind: 'not_found' as const, message: 'source interpretation not found' }

      const sourceOrgId = interpretation.sourceVersion.source.organizationId
      if (sourceOrgId !== null && sourceOrgId !== ruleOrgId)
        return { kind: 'forbidden' as const, message: 'source interpretation belongs to a different organization' }

      // Compatibility is checked only for GOVERNING — supporting evidence never drives the
      // effect, so category/effect incompatibility does not reject a supporting binding.
      if (sourceRole === 'GOVERNING') {
        const compatible = isCompatibleGoverningEffect(interpretation.sourceVersion.source.sourceCategory, version.effectType)
        if (!compatible)
          return {
            kind: 'terminal' as const,
            message: `SOURCE_EFFECT_INCOMPATIBLE: ${interpretation.sourceVersion.source.sourceCategory} cannot govern ${version.effectType} under ${compatibilityPolicyVersion}`,
          }
      }

      const record = await createRuleSourceBindingRecord({ ruleVersionId, sourceInterpretationId, sourceRole }, tx)

      await recordAuditEvent(
        {
          organizationId: ruleOrgId,
          actorUserId,
          actionCode: 'rule_source_binding.created',
          entityType: 'RULE_SOURCE_BINDING',
          entityId: record.id,
          beforeState: null,
          afterState: ruleSourceBindingAuditSnapshot(record),
        },
        tx,
      )

      return { kind: 'created' as const, record }
    })

    if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: outcome.message }
    if (outcome.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN', message: outcome.message }
    if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }

    return { ok: true, value: toDto(outcome.record) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'a binding already exists for this rule version and source interpretation' }
    throw error
  }
}

export async function getRuleSourceBinding(id: string): Promise<RuleSourceBindingResult<RuleSourceBindingDto>> {
  if (!isRuleSourceBindingUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source binding id' }
  const record = await findRuleSourceBindingById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule source binding not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleSourceBindings(ruleVersionId: string): Promise<RuleSourceBindingResult<RuleSourceBindingDto[]>> {
  if (!isRuleSourceBindingUuid(ruleVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  const version = await findRuleVersionWithOrganization(ruleVersionId)
  if (!version || version.rule.organizationId === null)
    return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }

  const records = await findRuleSourceBindingsByRuleVersionId(ruleVersionId)
  return { ok: true, value: records.map(toDto) }
}

export async function evaluateExecutability(
  ruleVersionId: string,
  businessDateInput: unknown,
  dimensionInputs: Record<ApplicabilityDimensionKey, unknown>,
  // Internal test seam only — the HTTP route never passes it.
  internal: CandidateInternalOptions = {},
): Promise<RuleSourceBindingResult<ExecutabilityEvaluationDto>> {
  if (!isRuleSourceBindingUuid(ruleVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  const businessDate = normalizeBusinessDate(businessDateInput)
  if (!businessDate) return { ok: false, code: 'VALIDATION_ERROR', message: 'businessDate must be a YYYY-MM-DD date' }

  const context: ApplicabilityContext = {}
  for (const key of applicabilityDimensionKeys) {
    const field = normalizeOptionalUuidField(dimensionInputs[key])
    if (!field.valid) return { ok: false, code: 'VALIDATION_ERROR', message: `${key} must be a valid UUID or null` }
    context[key] = field.value
  }

  // Rule jurisdiction is authoritative from RuleDefinition — the client can never override it.
  const version = await findRuleVersionForExecutability(ruleVersionId)
  if (!version || version.rule.organizationId === null)
    return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }

  const ruleOrgId = version.rule.organizationId
  const ruleJurisdiction = version.rule.jurisdictionCode

  // facilityRegulatoryProfileId is server-derived from facilityId + businessDate and is never
  // client-suppliable on this endpoint (REF-01 §10) — any client-supplied value above is
  // unconditionally discarded and replaced below, exactly like jurisdictionCode above.
  context.facilityRegulatoryProfileId = null

  // Existence, tenancy and ancestry of the client-supplied facts first, so an unknown or foreign
  // facility keeps its 404/403 rather than being reported as a missing profile.
  const coherence = await validateApplicabilityContextCoherence(context, ruleOrgId, prisma)
  if (!coherence.ok) return { ok: false, code: coherence.code, message: coherence.message }

  // Audit F05: an explicitly supplied facility needs exactly one ACTIVE regulatory profile in force
  // on businessDate. None or several fails closed here — before applicability matching and before
  // the REFERENCE_ONLY branch — instead of silently evaluating without a profile or picking a row.
  // Omitting facilityId remains a valid generic evaluation.
  let resolvedProfile: { id: string; jurisdictionCode: string } | null = null
  if (context.facilityId) {
    const resolution = await resolveFacilityRegulatoryProfileForDate(context.facilityId, businessDate)
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

  const applicabilityRows = await findRuleApplicabilitiesByVersionId(ruleVersionId)
  const matchedIds = matchedApplicabilityIds(applicabilityRows, context)
  const applicabilityOk = ruleVersionMatches(applicabilityRows, context)

  const ruleLevelBlockers = new Set<string>()
  if (version.verificationStatus !== 'VERIFIED') ruleLevelBlockers.add('RULE_UNVERIFIED')
  if (!isEffective(version.effectiveFrom, version.effectiveTo, businessDate)) ruleLevelBlockers.add('RULE_NOT_EFFECTIVE')
  // REF-01 §10: the resolved facility regulatory profile's own jurisdiction must be compatible
  // with the RuleDefinition's authoritative jurisdiction — reuses the exact same blocker code
  // A3.3's governing-source jurisdiction check already uses, for a consistent contract.
  if (resolvedProfile && resolvedProfile.jurisdictionCode.trim().toUpperCase() !== ruleJurisdiction.trim().toUpperCase())
    ruleLevelBlockers.add('JURISDICTION_INCOMPATIBLE')
  if (!applicabilityOk) ruleLevelBlockers.add('APPLICABILITY_MISMATCH')

  // REFERENCE_ONLY is evaluated for verification/effective/applicability only — it can never
  // become POTENTIALLY_ALLOWED, and source-binding gates are not consulted at all.
  if (version.effectType === 'REFERENCE_ONLY') {
    return {
      ok: true,
      value: {
        gateStatus: 'REFERENCE_ONLY',
        compatibilityPolicyVersion,
        blockers: [...ruleLevelBlockers].sort(),
        matchedApplicabilityIds: matchedIds,
        governingBindingIds: [],
        supportingBindingIds: [],
        candidateSourceInterpretationIds: [],
        // REFERENCE_ONLY is deliberately non-executable — it never advances to A3.8 precedence.
        nextGate: null,
      },
    }
  }

  // RuleSourceScope's own dimension set is a strict subset of ApplicabilityContextV2 — built
  // once, reused for every governing candidate whose category requires typed scope proof.
  const scopeContext: ScopeContext = {
    facilityId: context.facilityId,
    payerId: context.payerId,
    tpaId: context.tpaId,
    networkId: context.networkId,
    insuranceProductId: context.insuranceProductId,
    providerContractId: context.providerContractId,
    tariffScheduleId: context.tariffScheduleId,
    tariffScheduleVersionId: context.tariffScheduleVersionId,
  }

  const bindings = await findRuleSourceBindingsForEvaluation(ruleVersionId)
  const governingBindingIds: string[] = []
  const supportingBindingIds: string[] = []
  const candidateSourceInterpretationIds: string[] = []
  const governingFailureBlockers = new Set<string>()
  let anyGoverningPassed = false

  for (const binding of bindings) {
    if (binding.sourceRole === 'SUPPORTING') {
      supportingBindingIds.push(binding.id)
      continue
    }

    governingBindingIds.push(binding.id)

    const bindingBlockers = await evaluateGoverningCandidateBlockers(
      binding.sourceInterpretation,
      {
        ruleOrganizationId: ruleOrgId,
        ruleJurisdictionCode: ruleJurisdiction,
        ruleEffectType: version.effectType,
        businessDate,
        scopeContext,
      },
      internal,
    )

    if (bindingBlockers.size === 0) {
      anyGoverningPassed = true
      candidateSourceInterpretationIds.push(binding.sourceInterpretationId)
    } else {
      for (const code of bindingBlockers) governingFailureBlockers.add(code)
    }
  }

  // A valid alternative governing candidate makes the rule potentially allowed regardless of
  // why sibling candidates failed — their individual reasons are not surfaced when unused.
  if (!anyGoverningPassed) {
    ruleLevelBlockers.add('MISSING_GOVERNING_SOURCE')
    for (const code of governingFailureBlockers) ruleLevelBlockers.add(code)
  }

  const gateStatus: ExecutabilityGateStatus =
    ruleLevelBlockers.size === 0 && anyGoverningPassed ? 'POTENTIALLY_ALLOWED' : 'BLOCKED'

  // Only a rule that has actually passed this gate may advance to A3.8 precedence —
  // BLOCKED has not passed, and REFERENCE_ONLY (handled above) is deliberately non-executable.
  const nextGate = gateStatus === 'POTENTIALLY_ALLOWED' ? 'A3.8_PRECEDENCE' : null

  return {
    ok: true,
    value: {
      gateStatus,
      compatibilityPolicyVersion,
      blockers: [...ruleLevelBlockers].sort(),
      matchedApplicabilityIds: matchedIds,
      governingBindingIds,
      supportingBindingIds,
      candidateSourceInterpretationIds,
      nextGate,
    },
  }
}
