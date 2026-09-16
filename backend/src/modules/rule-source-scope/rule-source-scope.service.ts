import { findRuleSourceById } from '../rule-source/rule-source.repository.ts'
import { normalizeOptionalUuidField } from '../rule-applicability/rule-applicability.validation.ts'
import { validateApplicabilityContextCoherence } from '../rule-applicability/rule-applicability.context-coherence.ts'
import type { RuleSourceScopeDto, RuleSourceScopeResult } from './rule-source-scope.types.ts'
import { isRuleSourceScopeUuid, scopeDimensionKeys, type ScopeDimensionKey } from './rule-source-scope.validation.ts'
import {
  createRuleSourceScopeRecord,
  findRuleSourceScopeById,
  findRuleSourceScopesBySourceId,
  findScopeTargetOrganizationId,
} from './rule-source-scope.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleSourceScopeAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleSourceScopeRecord = {
  id: string
  sourceId: string
  facilityId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  createdAt: Date
}

const dimensionLabels: Record<ScopeDimensionKey, string> = {
  facilityId: 'facility',
  payerId: 'payer',
  tpaId: 'tpa',
  networkId: 'network',
  insuranceProductId: 'insurance product',
  providerContractId: 'provider contract',
  tariffScheduleId: 'tariff schedule',
  tariffScheduleVersionId: 'tariff schedule version',
}

function toDto(record: RuleSourceScopeRecord): RuleSourceScopeDto {
  return {
    id: record.id,
    sourceId: record.sourceId,
    facilityId: record.facilityId,
    payerId: record.payerId,
    tpaId: record.tpaId,
    networkId: record.networkId,
    insuranceProductId: record.insuranceProductId,
    providerContractId: record.providerContractId,
    tariffScheduleId: record.tariffScheduleId,
    tariffScheduleVersionId: record.tariffScheduleVersionId,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createRuleSourceScope(
  sourceId: string,
  dimensionInputs: Record<ScopeDimensionKey, unknown>,
  actorUserId: string,
): Promise<RuleSourceScopeResult<RuleSourceScopeDto>> {
  if (!isRuleSourceScopeUuid(sourceId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source id' }

  const source = await findRuleSourceById(sourceId)
  if (!source) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }
  // Defense-in-depth: the route's own permission middleware already 404s a SYSTEM_SHARED
  // source (null organizationId) before this service is ever reached — mirrors A3.6/A3.7.
  if (source.organizationId === null) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }

  const normalized: Record<ScopeDimensionKey, string | null> = {
    facilityId: null,
    payerId: null,
    tpaId: null,
    networkId: null,
    insuranceProductId: null,
    providerContractId: null,
    tariffScheduleId: null,
    tariffScheduleVersionId: null,
  }
  for (const key of scopeDimensionKeys) {
    const field = normalizeOptionalUuidField(dimensionInputs[key])
    if (!field.valid) return { ok: false, code: 'VALIDATION_ERROR', message: `${key} must be a valid UUID or null` }
    normalized[key] = field.value
  }

  if (scopeDimensionKeys.every((key) => normalized[key] === null))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one scope dimension is required' }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      for (const key of scopeDimensionKeys) {
        const targetId = normalized[key]
        if (targetId === null) continue
        const targetOrgId = await findScopeTargetOrganizationId(key, targetId, tx)
        if (targetOrgId === null) return { kind: 'not_found' as const, message: `${dimensionLabels[key]} not found` }
        if (targetOrgId !== source.organizationId)
          return { kind: 'forbidden' as const, message: `${dimensionLabels[key]} belongs to a different organization` }
      }

      // REF-01 §8 T67: product/network/contract/tariff hierarchy contradictions rejected —
      // reuses A3.6's own coherence validator since RuleSourceScope's 8 dimensions are a strict
      // subset of ApplicabilityContextV2 (unset fields are skipped, never checked).
      const coherence = await validateApplicabilityContextCoherence(normalized, source.organizationId as string, tx)
      if (!coherence.ok) {
        if (coherence.code === 'NOT_FOUND') return { kind: 'not_found' as const, message: coherence.message }
        if (coherence.code === 'FORBIDDEN') return { kind: 'forbidden' as const, message: coherence.message }
        return { kind: 'terminal' as const, message: coherence.message }
      }

      const record = await createRuleSourceScopeRecord({ sourceId, ...normalized }, tx)

      await recordAuditEvent(
        {
          organizationId: source.organizationId as string,
          actorUserId,
          actionCode: 'rule_source_scope.created',
          entityType: 'RULE_SOURCE_SCOPE',
          entityId: record.id,
          beforeState: null,
          afterState: ruleSourceScopeAuditSnapshot(record),
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
      return { ok: false, code: 'VALIDATION_ERROR', message: 'an identical scope row already exists for this rule source' }
    throw error
  }
}

export async function getRuleSourceScope(id: string): Promise<RuleSourceScopeResult<RuleSourceScopeDto>> {
  if (!isRuleSourceScopeUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source scope id' }
  const record = await findRuleSourceScopeById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule source scope not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleSourceScopes(sourceId: string): Promise<RuleSourceScopeResult<RuleSourceScopeDto[]>> {
  if (!isRuleSourceScopeUuid(sourceId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source id' }

  const source = await findRuleSourceById(sourceId)
  if (!source || source.organizationId === null) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }

  const records = await findRuleSourceScopesBySourceId(sourceId)
  return { ok: true, value: records.map(toDto) }
}
