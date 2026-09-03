export const auditActionCodes = [
  'organization.updated',
  'facility.created',
  'facility.updated',
] as const

export type AuditActionCode = (typeof auditActionCodes)[number]
export type AuditEntityType = 'ORGANIZATION' | 'FACILITY'

export type AuditWriteInput = {
  organizationId: string
  actorUserId: string
  actionCode: AuditActionCode
  entityType: AuditEntityType
  entityId: string
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
}

export type AuditEventDto = {
  id: string
  actorUserId: string
  actionCode: string
  entityType: string
  entityId: string
  occurredAt: string
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
}
