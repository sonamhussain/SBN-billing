import { findRuleSourceVersionWithOrganization } from '../rule-source-version/rule-source-version.repository.ts'
import type {
  RuleSourceRelationshipDto,
  RuleSourceRelationshipListItemDto,
  RuleSourceRelationshipResult,
} from './rule-source-relationship.types.ts'
import {
  isRelationshipType,
  isRuleSourceRelationshipUuid,
  normalizeRelationshipDirection,
} from './rule-source-relationship.validation.ts'
import type { ActivationRelationshipSignals } from '../rule-source-version/rule-source-version.activation.ts'
import {
  countConflictsTouchingVersion,
  createRelationshipRecord,
  findIncomingRelationships,
  findOutgoingDependsOnTargets,
  findOutgoingRelationships,
  findRelationshipById,
} from './rule-source-relationship.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { ruleSourceRelationshipAuditSnapshot } from '../audit/audit.snapshot.ts'

type RuleSourceRelationshipRecord = {
  id: string
  fromSourceVersionId: string
  toSourceVersionId: string
  relationshipType: string
  createdAt: Date
}

function toDto(record: RuleSourceRelationshipRecord): RuleSourceRelationshipDto {
  return {
    id: record.id,
    fromSourceVersionId: record.fromSourceVersionId,
    toSourceVersionId: record.toSourceVersionId,
    relationshipType: record.relationshipType,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

// Walk existing SUPERSEDES edges starting at `startId`; true if `targetId` is reachable.
// Must run inside the same transaction as the prospective insert to avoid a race.
async function isReachableViaSupersedes(startId: string, targetId: string, tx: DbClient): Promise<boolean> {
  const visited = new Set<string>()
  const queue: string[] = [startId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (current === targetId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const edges = await tx.ruleSourceRelationship.findMany({
      where: { fromSourceVersionId: current, relationshipType: 'SUPERSEDES' },
      select: { toSourceVersionId: true },
    })
    for (const edge of edges) queue.push(edge.toSourceVersionId)
  }
  return false
}

export async function createRelationship(
  fromSourceVersionId: string,
  toSourceVersionIdInput: unknown,
  relationshipTypeInput: unknown,
  actorUserId: string,
): Promise<RuleSourceRelationshipResult<RuleSourceRelationshipDto>> {
  if (!isRuleSourceRelationshipUuid(fromSourceVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid source version id' }

  const toSourceVersionId = typeof toSourceVersionIdInput === 'string' ? toSourceVersionIdInput.trim() : ''
  if (!toSourceVersionId || !isRuleSourceRelationshipUuid(toSourceVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'toSourceVersionId is required and must be a valid UUID' }

  if (!isRelationshipType(relationshipTypeInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'relationshipType is invalid' }
  const relationshipType = relationshipTypeInput

  if (fromSourceVersionId === toSourceVersionId)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'a source version cannot relate to itself' }

  const outcome = await prisma.$transaction(async (tx) => {
    const fromVersion = await findRuleSourceVersionWithOrganization(fromSourceVersionId, tx)
    if (!fromVersion) return { kind: 'not_found' as const, message: 'from source version not found' }

    const toVersion = await findRuleSourceVersionWithOrganization(toSourceVersionId, tx)
    if (!toVersion) return { kind: 'not_found' as const, message: 'to source version not found' }

    // FROM ownership is already gated by the route's permission middleware (resolved from
    // fromSourceVersionId). TO must be the same organization or SYSTEM_SHARED — never a
    // different tenant's data.
    if (toVersion.source.organizationId !== null && toVersion.source.organizationId !== fromVersion.source.organizationId) {
      return { kind: 'forbidden' as const, message: 'toSourceVersionId belongs to a different organization' }
    }

    if (relationshipType === 'SUPERSEDES') {
      const cyclic = await isReachableViaSupersedes(toSourceVersionId, fromSourceVersionId, tx)
      if (cyclic) return { kind: 'cycle' as const, message: 'this SUPERSEDES edge would create a cycle' }
    }

    let record: RuleSourceRelationshipRecord
    try {
      record = await createRelationshipRecord({ fromSourceVersionId, toSourceVersionId, relationshipType }, tx)
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return { kind: 'duplicate' as const, message: 'this relationship already exists' }
      throw error
    }

    const organizationId = (fromVersion.source.organizationId ?? toVersion.source.organizationId) as string

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'rule_source_relationship.created',
        entityType: 'RULE_SOURCE_RELATIONSHIP',
        entityId: record.id,
        beforeState: null,
        afterState: ruleSourceRelationshipAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'created' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: outcome.message }
  if (outcome.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN', message: outcome.message }
  if (outcome.kind === 'cycle') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  if (outcome.kind === 'duplicate') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }

  return { ok: true, value: toDto(outcome.record) }
}

export async function getRelationship(id: string): Promise<RuleSourceRelationshipResult<RuleSourceRelationshipDto>> {
  if (!isRuleSourceRelationshipUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid relationship id' }
  const record = await findRelationshipById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'relationship not found' }
  return { ok: true, value: toDto(record) }
}

export async function listRelationshipsForVersion(
  versionId: string,
  directionInput: unknown,
): Promise<RuleSourceRelationshipResult<RuleSourceRelationshipListItemDto[]>> {
  if (!isRuleSourceRelationshipUuid(versionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid source version id' }

  const version = await findRuleSourceVersionWithOrganization(versionId)
  if (!version) return { ok: false, code: 'NOT_FOUND', message: 'source version not found' }

  const direction = normalizeRelationshipDirection(directionInput)
  const items: RuleSourceRelationshipListItemDto[] = []

  if (direction === 'outgoing' || direction === 'all') {
    const outgoing = await findOutgoingRelationships(versionId)
    items.push(...outgoing.map((record) => ({ ...toDto(record), direction: 'outgoing' as const })))
  }
  if (direction === 'incoming' || direction === 'all') {
    const incoming = await findIncomingRelationships(versionId)
    items.push(...incoming.map((record) => ({ ...toDto(record), direction: 'incoming' as const })))
  }

  return { ok: true, value: items }
}

// Used by rule-source-version.service.ts's activation evaluator call sites. Kept here so the
// A3.3 evaluator stays pure/no-I/O — relationship graph lookups happen before it is invoked.
export async function computeActivationRelationshipSignals(
  versionId: string,
  db: DbClient = prisma,
): Promise<ActivationRelationshipSignals> {
  const dependsOnEdges = await findOutgoingDependsOnTargets(versionId, db)
  const hasUnresolvedDependency = dependsOnEdges.some((edge) => edge.toSourceVersion.activationStatus !== 'ACTIVE')

  const conflictCount = await countConflictsTouchingVersion(versionId, db)
  const hasConflict = conflictCount > 0

  return { hasUnresolvedDependency, hasConflict }
}
