import { findRuleVersionWithOrganization } from '../rule-version/rule-version.repository.ts'
import type { ApplicabilityEvaluationDto, RuleApplicabilityDto, RuleApplicabilityResult } from './rule-applicability.types.ts'
import {
  applicabilityDimensionKeys,
  isRuleApplicabilityUuid,
  normalizeOptionalUuidField,
  type ApplicabilityDimensionKey,
} from './rule-applicability.validation.ts'
import { ruleVersionMatches, matchedApplicabilityIds, type ApplicabilityContext } from './rule-applicability.matcher.ts'
import {
  createRuleApplicabilityRecord,
  findRuleApplicabilityById,
  findRuleApplicabilitiesByVersionId,
  findRuleApplicabilityWithOrganization,
  findTargetOrganizationId,
} from './rule-applicability.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleApplicabilityAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleApplicabilityRecord = {
  id: string
  ruleVersionId: string
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  createdAt: Date
}

const dimensionLabels: Record<ApplicabilityDimensionKey, string> = {
  payerId: 'payer',
  tpaId: 'tpa',
  networkId: 'network',
  serviceId: 'service',
  procedureCodeId: 'procedure code',
  diagnosisCodeId: 'diagnosis code',
}

const terminalVerificationStatuses: readonly string[] = ['VERIFIED', 'REJECTED']

function toDto(record: RuleApplicabilityRecord): RuleApplicabilityDto {
  return {
    id: record.id,
    ruleVersionId: record.ruleVersionId,
    payerId: record.payerId,
    tpaId: record.tpaId,
    networkId: record.networkId,
    serviceId: record.serviceId,
    procedureCodeId: record.procedureCodeId,
    diagnosisCodeId: record.diagnosisCodeId,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createRuleApplicability(
  ruleVersionId: string,
  dimensionInputs: Record<ApplicabilityDimensionKey, unknown>,
  hasUnknownFieldAttempt: boolean,
  actorUserId: string,
): Promise<RuleApplicabilityResult<RuleApplicabilityDto>> {
  if (!isRuleApplicabilityUuid(ruleVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  if (hasUnknownFieldAttempt)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'unknown fields are not allowed' }

  const normalized: Record<ApplicabilityDimensionKey, string | null> = {
    payerId: null,
    tpaId: null,
    networkId: null,
    serviceId: null,
    procedureCodeId: null,
    diagnosisCodeId: null,
  }
  for (const key of applicabilityDimensionKeys) {
    const field = normalizeOptionalUuidField(dimensionInputs[key])
    if (!field.valid) return { ok: false, code: 'VALIDATION_ERROR', message: `${key} must be a valid UUID or null` }
    normalized[key] = field.value
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const version = await findRuleVersionWithOrganization(ruleVersionId, tx)
      if (!version) return { kind: 'not_found' as const, message: 'rule version not found' }

      const organizationId = version.rule.organizationId
      // Defense-in-depth: the route's own permission middleware already 404s a SYSTEM_SHARED
      // parent (null organizationId) before this service is ever reached.
      if (organizationId === null) return { kind: 'not_found' as const, message: 'rule version not found' }

      if (terminalVerificationStatuses.includes(version.verificationStatus))
        return {
          kind: 'terminal' as const,
          message: 'rule version is VERIFIED or REJECTED; create a new rule version instead',
        }

      for (const key of applicabilityDimensionKeys) {
        const targetId = normalized[key]
        if (targetId === null) continue
        const targetOrgId = await findTargetOrganizationId(key, targetId, tx)
        if (targetOrgId === null)
          return { kind: 'not_found' as const, message: `${dimensionLabels[key]} not found` }
        if (targetOrgId !== organizationId)
          return { kind: 'forbidden' as const, message: `${dimensionLabels[key]} belongs to a different organization` }
      }

      const record = await createRuleApplicabilityRecord({ ruleVersionId, ...normalized }, tx)

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'rule_applicability.created',
          entityType: 'RULE_APPLICABILITY',
          entityId: record.id,
          beforeState: null,
          afterState: ruleApplicabilityAuditSnapshot(record),
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
      return { ok: false, code: 'VALIDATION_ERROR', message: 'an identical applicability row already exists for this rule version' }
    throw error
  }
}

export async function getRuleApplicability(id: string): Promise<RuleApplicabilityResult<RuleApplicabilityDto>> {
  if (!isRuleApplicabilityUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule applicability id' }
  const record = await findRuleApplicabilityById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule applicability not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleApplicabilities(ruleVersionId: string): Promise<RuleApplicabilityResult<RuleApplicabilityDto[]>> {
  if (!isRuleApplicabilityUuid(ruleVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  const version = await findRuleVersionWithOrganization(ruleVersionId)
  if (!version || version.rule.organizationId === null)
    return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }

  const records = await findRuleApplicabilitiesByVersionId(ruleVersionId)
  return { ok: true, value: records.map(toDto) }
}

export async function evaluateRuleApplicability(
  ruleVersionId: string,
  dimensionInputs: Record<ApplicabilityDimensionKey, unknown>,
): Promise<RuleApplicabilityResult<ApplicabilityEvaluationDto>> {
  if (!isRuleApplicabilityUuid(ruleVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule version id' }

  const version = await findRuleVersionWithOrganization(ruleVersionId)
  if (!version || version.rule.organizationId === null)
    return { ok: false, code: 'NOT_FOUND', message: 'rule version not found' }

  const context: ApplicabilityContext = {}
  for (const key of applicabilityDimensionKeys) {
    const field = normalizeOptionalUuidField(dimensionInputs[key])
    if (!field.valid) return { ok: false, code: 'VALIDATION_ERROR', message: `${key} must be a valid UUID or null` }
    context[key] = field.value
  }

  const rows = await findRuleApplicabilitiesByVersionId(ruleVersionId)
  const matches = ruleVersionMatches(rows, context)
  const matchedIds = matchedApplicabilityIds(rows, context)

  return { ok: true, value: { matches, matchedApplicabilityIds: matchedIds } }
}
