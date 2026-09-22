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
  'rule_definition.created',
  'rule_definition.updated',
  'rule_version.created',
  'rule_version.updated',
  'rule_version.verification_updated',
  'rule_applicability.created',
  'rule_source_binding.created',
  'facility_regulatory_profile.created',
  'facility_regulatory_profile.updated',
  'facility_regulatory_profile.activated',
  'insurance_product.created',
  'insurance_product.updated',
  'product_network.created',
  'provider_contract.created',
  'provider_contract.updated',
  'contract_facility.created',
  'tariff_schedule.created',
  'tariff_schedule.updated',
  'tariff_schedule_version.created',
  'tariff_schedule_version.lifecycle_updated',
  'tariff_schedule_version.verification_updated',
  'rule_source_scope.created',
  // A3.9 — successful rule pack mutations only. The provenance composer writes no audit.
  'rule_pack.created',
  'rule_pack.updated',
  'rule_pack_version.created',
  'rule_pack_version.updated',
  'rule_pack_member.added',
  'rule_pack_member.removed',
  'rule_pack_version.verified',
  'rule_pack_version.activated',
  'rule_pack_version.superseded',
  // A4.1 — patient audit carries safe metadata only; demographics never enter AuditEvent.
  'patient.created',
  'patient.updated',
  // A4.2 — assignments are created and closed; there is no update or delete action.
  'clinicianFacilityAssignment.created',
  'clinicianFacilityAssignment.closed',
  'clinicianSpecialtyAssignment.created',
  'clinicianSpecialtyAssignment.closed',
] as const

export type AuditActionCode = (typeof auditActionCodes)[number]
export type AuditEntityType = 'ORGANIZATION' | 'FACILITY' | 'CLINICIAN' | 'SPECIALTY' | 'PAYER' | 'TPA' | 'NETWORK' | 'SERVICE' | 'PROCEDURE_CODE' | 'DIAGNOSIS_CODE' | 'EXTERNAL_IDENTIFIER' | 'RULE_SOURCE' | 'RULE_SOURCE_VERSION' | 'SOURCE_INTERPRETATION' | 'RULE_SOURCE_RELATIONSHIP' | 'RULE_DEFINITION' | 'RULE_VERSION' | 'RULE_APPLICABILITY' | 'RULE_SOURCE_BINDING' | 'FACILITY_REGULATORY_PROFILE' | 'INSURANCE_PRODUCT' | 'PRODUCT_NETWORK' | 'PROVIDER_CONTRACT' | 'CONTRACT_FACILITY' | 'TARIFF_SCHEDULE' | 'TARIFF_SCHEDULE_VERSION' | 'RULE_SOURCE_SCOPE' | 'RULE_PACK' | 'RULE_PACK_VERSION' | 'RULE_PACK_MEMBER' | 'PATIENT' | 'CLINICIAN_FACILITY_ASSIGNMENT' | 'CLINICIAN_SPECIALTY_ASSIGNMENT'

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
