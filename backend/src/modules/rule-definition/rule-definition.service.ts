import { getOrganization } from '../organization/organization.service.ts'
import type { RuleDefinitionDto, RuleDefinitionResult } from './rule-definition.types.ts'
import {
  isRuleDefinitionUuid,
  normalizeDisplayName,
  normalizeJurisdictionCode,
  normalizeRuleKey,
} from './rule-definition.validation.ts'
import {
  createRuleDefinitionRecord,
  findRuleDefinitionsByOrganizationId,
  findRuleDefinitionById,
  updateRuleDefinitionRecord,
} from './rule-definition.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleDefinitionAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleDefinitionRecord = {
  id: string
  organizationId: string | null
  ruleKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: RuleDefinitionRecord): RuleDefinitionDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    ruleKey: record.ruleKey,
    displayName: record.displayName,
    jurisdictionCode: record.jurisdictionCode,
    ownershipScope: record.ownershipScope,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function createRuleDefinition(
  organizationId: string,
  ruleKeyInput: unknown,
  displayNameInput: unknown,
  jurisdictionCodeInput: unknown,
  actorUserId: string,
): Promise<RuleDefinitionResult<RuleDefinitionDto>> {
  if (!isRuleDefinitionUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const ruleKey = normalizeRuleKey(ruleKeyInput)
  if (!ruleKey) return { ok: false, code: 'VALIDATION_ERROR', message: 'ruleKey is required' }

  const displayName = normalizeDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const jurisdictionCode = normalizeJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Tenant POST always creates an ORGANIZATION-scoped rule definition. The client
      // cannot control ownershipScope or organizationId — both are derived here, never from the body.
      const record = await createRuleDefinitionRecord(
        { organizationId, ruleKey, displayName, jurisdictionCode, ownershipScope: 'ORGANIZATION' },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'rule_definition.created',
          entityType: 'RULE_DEFINITION',
          entityId: record.id,
          beforeState: null,
          afterState: ruleDefinitionAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'ruleKey already exists for this organization and jurisdiction' }
    throw error
  }
}

export async function getRuleDefinition(id: string): Promise<RuleDefinitionResult<RuleDefinitionDto>> {
  if (!isRuleDefinitionUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule definition id' }
  const record = await findRuleDefinitionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule definition not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleDefinitions(organizationId: string): Promise<RuleDefinitionResult<RuleDefinitionDto[]>> {
  if (!isRuleDefinitionUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findRuleDefinitionsByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateRuleDefinition(
  id: string,
  displayNameInput: unknown,
  hasImmutableFieldAttempt: boolean,
  actorUserId: string,
): Promise<RuleDefinitionResult<RuleDefinitionDto>> {
  if (!isRuleDefinitionUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule definition id' }

  if (hasImmutableFieldAttempt)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'id, organizationId, ownershipScope, ruleKey, jurisdictionCode, createdAt and updatedAt cannot be changed',
    }

  const displayName = normalizeDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findRuleDefinitionById(id, tx)
    if (!existing) return null

    const record = await updateRuleDefinitionRecord(id, { displayName }, tx)

    await recordAuditEvent(
      {
        organizationId: existing.organizationId as string,
        actorUserId,
        actionCode: 'rule_definition.updated',
        entityType: 'RULE_DEFINITION',
        entityId: id,
        beforeState: ruleDefinitionAuditSnapshot(existing),
        afterState: ruleDefinitionAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'rule definition not found' }

  return { ok: true, value: toDto(updated) }
}
