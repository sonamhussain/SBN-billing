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

// Postgres serialization failure under SERIALIZABLE isolation (concurrent SUPERSEDES writes
// whose cycle checks raced each other) — Prisma surfaces this as P2034. Never let it escape
// as a raw 500; retry the whole transaction a bounded number of times instead.
function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

const MAX_SUPERSEDES_RETRIES = 3

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

  // SUPERSEDES is the only type whose validity (the cycle check) depends on other concurrently
  // inserted rows, so only it needs SERIALIZABLE isolation + retry — everything else here reads
  // effectively-immutable data (RuleSource.organizationId) or relies on the DB unique constraint,
  // both of which are already race-safe under the default isolation level.
  const txOptions =
    relationshipType === 'SUPERSEDES' ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined
  const maxAttempts = relationshipType === 'SUPERSEDES' ? MAX_SUPERSEDES_RETRIES : 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const fromVersion = await findRuleSourceVersionWithOrganization(fromSourceVersionId, tx)
        if (!fromVersion) return { kind: 'not_found' as const, message: 'from source version not found' }

        const toVersion = await findRuleSourceVersionWithOrganization(toSourceVersionId, tx)
        if (!toVersion) return { kind: 'not_found' as const, message: 'to source version not found' }

        const fromOrgId = fromVersion.source.organizationId
        const toOrgId = toVersion.source.organizationId

        // Belt-and-suspenders alongside the route's permission middleware (which already 404s
        // a SYSTEM_SHARED FROM, since it resolves to no organizationId to authorize against) —
        // tenant APIs must never author a relationship FROM a SYSTEM_SHARED version.
        if (fromOrgId === null) {
          return {
            kind: 'forbidden' as const,
            message: 'system-shared source relationships cannot be authored by tenant users',
          }
        }

        // TO must be the same organization or SYSTEM_SHARED — never a different tenant's data.
        if (toOrgId !== null && toOrgId !== fromOrgId) {
          return { kind: 'forbidden' as const, message: 'toSourceVersionId belongs to a different organization' }
        }

        // An organization may read/reference/depend-on/conflict-with shared truth, but must
        // never claim authority over it — AMENDS/SUPERSEDES would let a tenant assert its own
        // document amends or supersedes platform-level shared governance (and SUPERSEDES has a
        // real lifecycle side effect: successor ACTIVE -> target SUPERSEDED).
        if (toOrgId === null && (relationshipType === 'AMENDS' || relationshipType === 'SUPERSEDES')) {
          return {
            kind: 'forbidden' as const,
            message: 'organization-owned sources cannot amend or supersede system-shared sources',
          }
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

        await recordAuditEvent(
          {
            organizationId: fromOrgId,
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
      }, txOptions)

      if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: outcome.message }
      if (outcome.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN', message: outcome.message }
      if (outcome.kind === 'cycle') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
      if (outcome.kind === 'duplicate') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }

      return { ok: true, value: toDto(outcome.record) }
    } catch (error) {
      if (isSerializationConflict(error) && attempt < maxAttempts) {
        console.warn(
          `[rule-source-relationship] SERIALIZABLE conflict on SUPERSEDES create (attempt ${attempt}/${maxAttempts}) — retrying`,
        )
        continue
      }
      if (isSerializationConflict(error)) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: 'this relationship could not be created due to a concurrent conflict; please retry',
        }
      }
      throw error
    }
  }

  throw new Error('createRelationship: exhausted retries without resolving')
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
