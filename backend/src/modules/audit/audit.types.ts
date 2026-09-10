export const auditActionCodes = [
  'organization.updated',
  'facility.created',
  'facility.updated',
  'clinician.created',
  'clinician.updated',
  'specialty.created',
  'specialty.updated',
  'payer.created',
  'payer.updated',
  'tpa.created',
  'tpa.updated',
  'network.created',
  'network.updated',
  'service.created',
  'service.updated',
  'procedure_code.created',
  'procedure_code.updated',
  'diagnosisCode.created',
  'diagnosisCode.updated',
  'external_identifier.created',
  'external_identifier.updated',
] as const

export type AuditActionCode = (typeof auditActionCodes)[number]
export type AuditEntityType = 'ORGANIZATION' | 'FACILITY' | 'CLINICIAN' | 'SPECIALTY' | 'PAYER' | 'TPA' | 'NETWORK' | 'SERVICE' | 'PROCEDURE_CODE' | 'DIAGNOSIS_CODE' | 'EXTERNAL_IDENTIFIER'

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
