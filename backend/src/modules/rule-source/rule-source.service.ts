import { getOrganization } from '../organization/organization.service.ts'
import type { RuleSourceDto, RuleSourceResult } from './rule-source.types.ts'
import {
  isRuleSourceUuid,
  normalizeIssuingAuthority,
  normalizeJurisdictionCode,
  normalizeReferenceNumber,
  normalizeSourceCategory,
  normalizeTitle,
} from './rule-source.validation.ts'
import {
  createRuleSourceRecord,
  findRuleSourcesByOrganizationId,
  findRuleSourceById,
  updateRuleSourceRecord,
} from './rule-source.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleSourceAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleSourceRecord = {
  id: string
  organizationId: string | null
  jurisdictionCode: string
  issuingAuthority: string
  sourceCategory: string
  referenceNumber: string
  title: string
  ownershipScope: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: RuleSourceRecord): RuleSourceDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    jurisdictionCode: record.jurisdictionCode,
    issuingAuthority: record.issuingAuthority,
    sourceCategory: record.sourceCategory,
    referenceNumber: record.referenceNumber,
    title: record.title,
    ownershipScope: record.ownershipScope,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createRuleSource(
  organizationId: string,
  jurisdictionCodeInput: unknown,
  issuingAuthorityInput: unknown,
  sourceCategoryInput: unknown,
  referenceNumberInput: unknown,
  titleInput: unknown,
  actorUserId: string,
): Promise<RuleSourceResult<RuleSourceDto>> {
  if (!isRuleSourceUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const jurisdictionCode = normalizeJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  const issuingAuthority = normalizeIssuingAuthority(issuingAuthorityInput)
  if (!issuingAuthority) return { ok: false, code: 'VALIDATION_ERROR', message: 'issuingAuthority is required' }

  const sourceCategory = normalizeSourceCategory(sourceCategoryInput)
  if (!sourceCategory) return { ok: false, code: 'VALIDATION_ERROR', message: 'sourceCategory is invalid' }

  const referenceNumber = normalizeReferenceNumber(referenceNumberInput)
  if (!referenceNumber) return { ok: false, code: 'VALIDATION_ERROR', message: 'referenceNumber is required' }

  const title = normalizeTitle(titleInput)
  if (!title) return { ok: false, code: 'VALIDATION_ERROR', message: 'title is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const created = await prisma.$transaction(async (tx) => {
    // Tenant POST always creates an ORGANIZATION-scoped source. The client cannot
    // control ownershipScope or organizationId — both are derived here, never from the body.
    const record = await createRuleSourceRecord(
      {
        organizationId,
        jurisdictionCode,
        issuingAuthority,
        sourceCategory,
        referenceNumber,
        title,
        ownershipScope: 'ORGANIZATION',
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'rule_source.created',
        entityType: 'RULE_SOURCE',
        entityId: record.id,
        beforeState: null,
        afterState: ruleSourceAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getRuleSource(id: string): Promise<RuleSourceResult<RuleSourceDto>> {
  if (!isRuleSourceUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source id' }
  const record = await findRuleSourceById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRuleSources(organizationId: string): Promise<RuleSourceResult<RuleSourceDto[]>> {
  if (!isRuleSourceUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  const records = await findRuleSourcesByOrganizationId(organizationId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateRuleSource(
  id: string,
  jurisdictionCodeInput: unknown,
  issuingAuthorityInput: unknown,
  sourceCategoryInput: unknown,
  referenceNumberInput: unknown,
  titleInput: unknown,
  hasImmutableFieldAttempt: boolean,
  actorUserId: string,
): Promise<RuleSourceResult<RuleSourceDto>> {
  if (!isRuleSourceUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source id' }

  if (hasImmutableFieldAttempt)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'id, organizationId, ownershipScope, createdAt and updatedAt cannot be changed' }

  const hasJurisdictionCode = jurisdictionCodeInput !== undefined
  const hasIssuingAuthority = issuingAuthorityInput !== undefined
  const hasSourceCategory = sourceCategoryInput !== undefined
  const hasReferenceNumber = referenceNumberInput !== undefined
  const hasTitle = titleInput !== undefined

  if (!hasJurisdictionCode && !hasIssuingAuthority && !hasSourceCategory && !hasReferenceNumber && !hasTitle)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let jurisdictionCode: string | null = null
  if (hasJurisdictionCode) {
    jurisdictionCode = normalizeJurisdictionCode(jurisdictionCodeInput)
    if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }
  }

  let issuingAuthority: string | null = null
  if (hasIssuingAuthority) {
    issuingAuthority = normalizeIssuingAuthority(issuingAuthorityInput)
    if (!issuingAuthority) return { ok: false, code: 'VALIDATION_ERROR', message: 'issuingAuthority is required' }
  }

  let sourceCategory: string | null = null
  if (hasSourceCategory) {
    sourceCategory = normalizeSourceCategory(sourceCategoryInput)
    if (!sourceCategory) return { ok: false, code: 'VALIDATION_ERROR', message: 'sourceCategory is invalid' }
  }

  let referenceNumber: string | null = null
  if (hasReferenceNumber) {
    referenceNumber = normalizeReferenceNumber(referenceNumberInput)
    if (!referenceNumber) return { ok: false, code: 'VALIDATION_ERROR', message: 'referenceNumber is required' }
  }

  let title: string | null = null
  if (hasTitle) {
    title = normalizeTitle(titleInput)
    if (!title) return { ok: false, code: 'VALIDATION_ERROR', message: 'title is required' }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findRuleSourceById(id, tx)
    if (!existing) return null

    const record = await updateRuleSourceRecord(
      id,
      {
        ...(jurisdictionCode ? { jurisdictionCode } : {}),
        ...(issuingAuthority ? { issuingAuthority } : {}),
        ...(sourceCategory ? { sourceCategory } : {}),
        ...(referenceNumber ? { referenceNumber } : {}),
        ...(title ? { title } : {}),
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: existing.organizationId as string,
        actorUserId,
        actionCode: 'rule_source.updated',
        entityType: 'RULE_SOURCE',
        entityId: id,
        beforeState: ruleSourceAuditSnapshot(existing),
        afterState: ruleSourceAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  if (!updated) return { ok: false, code: 'NOT_FOUND', message: 'rule source not found' }

  return { ok: true, value: toDto(updated) }
}
