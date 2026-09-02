import type { DbClient } from '../../shared/database/database.types.ts'
import type { AuditEventDto, AuditWriteInput } from './audit.types.ts'
import { createAuditEventRecord, findAuditEventsByOrganization } from './audit.repository.ts'

export async function recordAuditEvent(input: AuditWriteInput, db: DbClient) {
  return createAuditEventRecord(input, db)
}

function toDto(record: {
  id: string
  actorUserId: string
  actionCode: string
  entityType: string
  entityId: string
  occurredAt: Date
  beforeState: unknown
  afterState: unknown
}): AuditEventDto {
  return {
    id: record.id,
    actorUserId: record.actorUserId,
    actionCode: record.actionCode,
    entityType: record.entityType,
    entityId: record.entityId,
    occurredAt: record.occurredAt.toISOString(),
    beforeState: (record.beforeState as Record<string, unknown> | null) ?? null,
    afterState: (record.afterState as Record<string, unknown> | null) ?? null,
  }
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export async function listOrganizationAuditEvents(
  organizationId: string,
  limitInput?: number,
): Promise<AuditEventDto[]> {
  const limit = Math.min(limitInput && limitInput > 0 ? limitInput : DEFAULT_LIMIT, MAX_LIMIT)
  const records = await findAuditEventsByOrganization(organizationId, limit)
  return records.map(toDto)
}
