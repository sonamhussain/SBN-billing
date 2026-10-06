import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
// A5.5 owns the current commercial context, and runs A4.9's integrity verification first. It is
// reused with this evaluation's own transaction client, so the context, the A3 resolution and the
// evidence pool all come from one snapshot.
import { resolvePreClaimCommercialContext } from '../pre-claim-commercial-context/pre-claim-commercial-context.service.ts'
// A3.8 resolves which RuleVersion applies, and A3.9 composes its provenance. A5.6 reimplements
// neither: no specificity, SUPERSEDES, source precedence or provenance logic lives in this module.
import { evaluateRuleResolutionBundle } from '../rule-resolution/rule-resolution.service.ts'
import { composeRuleDecisionProvenanceRefV1 } from '../rule-provenance/rule-provenance.composer.ts'
import { evaluateRequirement } from './evidence-completeness.resolver.ts'
import {
  DOCUMENTATION_EFFECT,
  type EvidenceCompletenessEvaluationV1,
  type EvidenceRequirementDto,
  type EvidenceRequirementResult,
  type RequirementCompletenessDto,
} from './evidence-requirement.types.ts'
import {
  isEvidenceRequirementUuid,
  requirementAuditSnapshot,
  sortedDocumentTypes,
  toRequirementDto,
  validateCompletenessTarget,
  validateRequirementBody,
} from './evidence-requirement.validation.ts'
import {
  createRequirementRecord,
  findActivityTarget,
  findDiagnosisTarget,
  findDocumentationRuleDefinitionIds,
  findEncounterEvidencePoolIds,
  findEvidenceFacts,
  findRequirementByRuleVersion,
  findResolvedRuleVersion,
  findRuleVersionForRequirement,
} from './evidence-requirement.repository.ts'

const invalid = (message: string): EvidenceRequirementResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const unresolved = (reason: 'REQUIREMENT_RESOLUTION_BLOCKED' | 'CONFIGURATION_INCOMPLETE', message: string): EvidenceRequirementResult<never> => ({
  ok: false,
  code: 'EVIDENCE_REQUIREMENT_UNRESOLVED',
  reason,
  message,
})

// ---------------------------------------------------------------- requirement payload (§4–§6, §15)

export async function createEvidenceRequirement(ruleVersionId: string, body: unknown, actorUserId: string): Promise<EvidenceRequirementResult<EvidenceRequirementDto>> {
  if (!isEvidenceRequirementUuid(ruleVersionId)) return invalid('invalid rule version id')
  const validated = validateRequirementBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx) => {
    // The RuleVersion row lock is the one A3's own lifecycle writes take, so attaching a payload and
    // a concurrent verification serialize: a version cannot become VERIFIED halfway through.
    if (!(await lockRowForUpdate(tx, 'rule_versions', ruleVersionId))) return { kind: 'missing' as const }
    await concurrencyProbe('evidence_requirement.version_locked')
    const version = await findRuleVersionForRequirement(ruleVersionId, tx)
    if (!version || version.rule.organizationId === null) return { kind: 'missing' as const }
    if (version.effectType !== DOCUMENTATION_EFFECT)
      return { kind: 'refused' as const, message: 'only a DOCUMENTATION_REQUIREMENT_EFFECT rule version can carry an evidence requirement' }
    if (version.verificationStatus !== 'UNVERIFIED')
      return { kind: 'refused' as const, message: 'an evidence requirement can be attached only while the rule version is UNVERIFIED; correct it with a new rule version' }
    if (await findRequirementByRuleVersion(ruleVersionId, tx))
      return { kind: 'refused' as const, message: 'this rule version already carries its evidence requirement; correct it with a new rule version' }

    const record = await createRequirementRecord(ruleVersionId, validated.value, tx)
    await recordAuditEvent(
      {
        organizationId: version.rule.organizationId,
        actorUserId,
        actionCode: 'evidence_requirement.created',
        entityType: 'EVIDENCE_REQUIREMENT',
        entityId: record.id,
        beforeState: null,
        afterState: requirementAuditSnapshot(record),
      },
      tx,
    )
    // Acceptance forces a failure here to prove the payload, its types and the audit roll back
    // together. A no-op in normal operation.
    await concurrencyProbe('evidence_requirement.created')
    return { kind: 'created' as const, record }
  })

  if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }
  if (outcome.kind === 'refused') return invalid(outcome.message)
  return { ok: true, value: toRequirementDto(outcome.record) }
}

export async function getEvidenceRequirement(ruleVersionId: string): Promise<EvidenceRequirementResult<EvidenceRequirementDto>> {
  if (!isEvidenceRequirementUuid(ruleVersionId)) return invalid('invalid rule version id')
  const record = await findRequirementByRuleVersion(ruleVersionId)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'evidence requirement not found' }
  return { ok: true, value: toRequirementDto(record) }
}

// ---------------------------------------------------------------- completeness (§8–§14, §17)

// A5.10 closure measured one HTTP evaluation at 13 s idle against the 15 s default snapshot bound, and
// over it under load (HTTP 500): A3.8 runs for every applicable governed documentation rule, and that
// set grows with governed data. The read snapshot keeps its isolation and READ ONLY guarantee; only
// its time limit is raised for this evaluation. A5.8 calls this with its own transaction and is unaffected.
const COMPLETENESS_SNAPSHOT_TIMEOUT_MS = 120_000

export async function evaluateEvidenceCompleteness(
  encounterId: string,
  body: unknown,
  db?: DbClient,
): Promise<EvidenceRequirementResult<EvidenceCompletenessEvaluationV1>> {
  if (!isEvidenceRequirementUuid(encounterId)) return invalid('invalid encounter id')
  const target = validateCompletenessTarget(body)
  if (!target.ok) return invalid(target.message)

  return withReadSnapshot(db, async (tx): Promise<EvidenceRequirementResult<EvidenceCompletenessEvaluationV1>> => {
    const evaluatedAt = await readTransactionTimestamp(tx)
    // Acceptance holds the evaluation here and commits a change from another connection; everything
    // below must still read the earlier state. A no-op in normal operation.
    await concurrencyProbe('evidence_completeness.snapshot')

    // §10 steps 1-3 — A4.9 integrity and the A5.5 commercial context, in this snapshot. A failure
    // keeps the code and reason its owner gave it.
    const commercial = await resolvePreClaimCommercialContext(encounterId, tx)
    if (!commercial.ok) return { ok: false, code: commercial.code, message: commercial.message, reason: commercial.reason }
    const context = commercial.value
    const serviceDate = new Date(`${context.serviceDate}T00:00:00.000Z`)

    // §10 step 4 — the optional targets, derived server-side from this Encounter's active rows. A
    // removed row, another Encounter's row and a missing id are refused identically.
    let serviceId: string | null = null
    let procedureCodeId: string | null = null
    let diagnosisCodeId: string | null = null
    if (target.value.encounterActivityId) {
      const activity = await findActivityTarget(target.value.encounterActivityId, tx)
      if (!activity || activity.encounterId !== encounterId || activity.removedAt !== null)
        return invalid('encounterActivityId is not an active activity of this encounter')
      serviceId = activity.serviceId
      procedureCodeId = activity.procedureCodeId
    }
    if (target.value.encounterDiagnosisId) {
      const diagnosis = await findDiagnosisTarget(target.value.encounterDiagnosisId, tx)
      if (!diagnosis || diagnosis.encounterId !== encounterId || diagnosis.removedAt !== null)
        return invalid('encounterDiagnosisId is not an active diagnosis of this encounter')
      diagnosisCodeId = diagnosis.diagnosisCodeId
    }

    // §10 step 5 — the exact ApplicabilityContextV2 dimensions A3.8 accepts from a caller. A3.8 derives
    // facilityRegulatoryProfileId itself, and is checked against A4's stored profile below.
    const contextInputs = {
      facilityId: context.facilityId,
      payerId: context.payerId,
      tpaId: context.tpaId,
      networkId: context.networkId,
      insuranceProductId: context.insuranceProductId,
      providerContractId: context.providerContractId,
      tariffScheduleId: context.tariffScheduleId,
      tariffScheduleVersionId: context.tariffScheduleVersionId,
      serviceId,
      procedureCodeId,
      diagnosisCodeId,
    }

    // §11 — every own-organization documentation RuleDefinition, each through A3.8 then A3.9.
    const resolved: Array<{ ruleDefinitionId: string; ruleVersionId: string; provenance: RequirementCompletenessDto['provenance'] }> = []
    for (const ruleDefinitionId of await findDocumentationRuleDefinitionIds(context.organizationId, DOCUMENTATION_EFFECT, tx)) {
      // A3.8 is given this evaluation's own transaction instant as its clock, so the provenance
      // evaluationTimestamp it issues is the same database instant as evaluatedAt — never the
      // application clock.
      const bundle = await evaluateRuleResolutionBundle(ruleDefinitionId, context.serviceDate, contextInputs, { db: tx, clock: () => evaluatedAt })
      if (!bundle.ok) return unresolved('REQUIREMENT_RESOLUTION_BLOCKED', `a documentation rule could not be resolved for this encounter: ${bundle.message}`)
      const resolution = bundle.value.resolution
      // NO_MATCH: the rule does not apply to this target. REFERENCE_ONLY: A3 found no governing,
      // executable source, so there is nothing enforceable (owner decision).
      if (resolution.resolutionStatus === 'NO_MATCH' || resolution.resolutionStatus === 'REFERENCE_ONLY') continue
      // Any blocked outcome fails the whole evaluation: an applicable rule is never silently dropped.
      if (resolution.resolutionStatus !== 'RESOLVED' || !resolution.ruleVersionId)
        return unresolved('REQUIREMENT_RESOLUTION_BLOCKED', `an applicable documentation rule is ${resolution.resolutionStatus} in A3 governance`)
      // A3.8 derives the regulatory profile from facility and date; it must be exactly the profile A4
      // stored on this Encounter, or the requirement was resolved against a different context.
      if (bundle.value.authoritativeContext.facilityRegulatoryProfileId !== context.facilityRegulatoryProfileId)
        return unresolved('REQUIREMENT_RESOLUTION_BLOCKED', "A3 resolved a different facility regulatory profile than the encounter's stored one")

      const version = await findResolvedRuleVersion(resolution.ruleVersionId, tx)
      if (!version || version.effectType !== DOCUMENTATION_EFFECT || !version.evidenceRequirement || version.evidenceRequirement.documentTypes.length === 0)
        return unresolved('CONFIGURATION_INCOMPLETE', 'a resolved documentation rule version has no complete evidence requirement payload')

      const provenance = await composeRuleDecisionProvenanceRefV1({ evaluation: bundle.value, rulePackVersionId: null }, tx)
      if (!provenance.ok) return unresolved('REQUIREMENT_RESOLUTION_BLOCKED', `the provenance of a resolved documentation rule could not be composed: ${provenance.error.message}`)
      resolved.push({ ruleDefinitionId, ruleVersionId: version.id, provenance: provenance.value })
    }

    // §8 — the exact, deduplicated evidence pool of this Encounter.
    const pool = (await findEvidenceFacts(await findEncounterEvidencePoolIds(encounterId, tx), tx)).map((row) => ({
      id: row.id,
      documentType: row.documentType,
      sourceDate: row.sourceDate,
    }))

    const requirements: RequirementCompletenessDto[] = []
    for (const entry of resolved) {
      const version = await findResolvedRuleVersion(entry.ruleVersionId, tx)
      const requirement = version!.evidenceRequirement!
      const acceptedDocumentTypes = sortedDocumentTypes(requirement.documentTypes)
      const spec = {
        acceptedDocumentTypes,
        minimumCount: requirement.minimumCount,
        sourceDateRequired: requirement.sourceDateRequired,
        maxSourceAgeDays: requirement.maxSourceAgeDays,
      }
      requirements.push({
        evidenceRequirementId: requirement.id,
        ruleVersionId: entry.ruleVersionId,
        provenance: entry.provenance,
        ...spec,
        ...evaluateRequirement(spec, pool, serviceDate),
      })
    }

    return {
      ok: true,
      value: {
        schemaVersion: 'EvidenceCompletenessEvaluationV1',
        evaluatedAt: evaluatedAt.toISOString(),
        encounterId,
        encounterActivityId: target.value.encounterActivityId,
        encounterDiagnosisId: target.value.encounterDiagnosisId,
        businessDate: formatDateOnly(serviceDate) as string,
        commercialContext: {
          providerContractId: context.providerContractId,
          tariffScheduleId: context.tariffScheduleId,
          tariffScheduleVersionId: context.tariffScheduleVersionId,
        },
        requirements,
      },
    }
  }, { timeoutMs: COMPLETENESS_SNAPSHOT_TIMEOUT_MS })
}
