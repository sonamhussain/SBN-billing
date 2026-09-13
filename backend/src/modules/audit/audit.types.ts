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
  'rule_source.created',
  'rule_source.updated',
  'rule_source_version.created',
  'source_interpretation.created',
  'source_interpretation.updated',
  'rule_source_version.lifecycle_updated',
  'rule_source_version.published',
  'rule_source_version.verification_updated',
  'rule_source_version.activation_blocked',
  'rule_source_version.activated',
  'rule_source_version.suspended',
  'rule_source_version.resumed',
  'rule_source_version.retired',
  'rule_source_relationship.created',
  'rule_source_version.superseded',
] as const

export type AuditActionCode = (typeof auditActionCodes)[number]
export type AuditEntityType = 'ORGANIZATION' | 'FACILITY' | 'CLINICIAN' | 'SPECIALTY' | 'PAYER' | 'TPA' | 'NETWORK' | 'SERVICE' | 'PROCEDURE_CODE' | 'DIAGNOSIS_CODE' | 'EXTERNAL_IDENTIFIER' | 'RULE_SOURCE' | 'RULE_SOURCE_VERSION' | 'SOURCE_INTERPRETATION' | 'RULE_SOURCE_RELATIONSHIP'

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
