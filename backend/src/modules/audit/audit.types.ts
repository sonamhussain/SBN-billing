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
  // A4.3 — membership audit names the context and which fields changed, never member/policy values.
  'insuranceMembership.created',
  'insuranceMembership.updated',
  // A4.4 — encounter audit proves THAT an encounter changed, never the patient, date, provider,
  // membership or context it holds.
  'encounter.created',
  'encounter.updated',
  // A4.5 — diagnosis audit proves THAT a link was added, moved or removed, never which diagnosis,
  // which encounter or any clinical text.
  'encounterDiagnosis.added',
  'encounterDiagnosis.reordered',
  'encounterDiagnosis.removed',
  // A4.6 — activity audit proves THAT an activity was captured or removed, never which service,
  // procedure, quantity, unit, modifier or encounter it holds.
  'encounterActivity.created',
  'encounterActivity.removed',
  // A4.7 — observation audit proves THAT a structured fact was recorded or removed, never its key,
  // value, unit, anchors or any clinical context.
  'encounterObservation.created',
  'encounterObservation.removed',

  // A5.1 - evidence identity and its immutable versions. There is no updated or removed
  // counterpart: a version is append-only, so the only thing that ever happens is a create.
  'evidence_artifact.created',
  'evidence_artifact_version.created',
  // A5.2 — recording an eligibility verification. There is no updated or deleted counterpart:
  // a correction is a new verification, and the database refuses the alternative.
  'eligibility_verification.created',
  // A5.3 — recording an authorization case and appending a lifecycle version. There is no
  // updated or deleted counterpart: a correction is a new version, and the database refuses
  // the alternative.
  'prior_authorization.created',
  'prior_authorization_version.created',
  // A5.4 — one event per captured authorization line. There is no updated or deleted counterpart:
  // a line set is captured once per version, and a correction is a new A5.3 version.
  'authorization_line.created',
  // A5.6 — attaching a requirement payload, and linking or removing an Encounter evidence link.
  // There is no updated or deleted counterpart for either: a payload is immutable, and a link is
  // corrected only by its one-way removal.
  'evidence_requirement.created',
  'encounter_evidence_link.created',
  'encounter_evidence_link.removed',
  // A5.7 — one event per complete validation run, never one per finding. A run is immutable, so
  // there is no updated or deleted counterpart.
  'validation_run.recorded',
] as const

export type AuditActionCode = (typeof auditActionCodes)[number]
export type AuditEntityType = 'ORGANIZATION' | 'FACILITY' | 'CLINICIAN' | 'SPECIALTY' | 'PAYER' | 'TPA' | 'NETWORK' | 'SERVICE' | 'PROCEDURE_CODE' | 'DIAGNOSIS_CODE' | 'EXTERNAL_IDENTIFIER' | 'RULE_SOURCE' | 'RULE_SOURCE_VERSION' | 'SOURCE_INTERPRETATION' | 'RULE_SOURCE_RELATIONSHIP' | 'RULE_DEFINITION' | 'RULE_VERSION' | 'RULE_APPLICABILITY' | 'RULE_SOURCE_BINDING' | 'FACILITY_REGULATORY_PROFILE' | 'INSURANCE_PRODUCT' | 'PRODUCT_NETWORK' | 'PROVIDER_CONTRACT' | 'CONTRACT_FACILITY' | 'TARIFF_SCHEDULE' | 'TARIFF_SCHEDULE_VERSION' | 'RULE_SOURCE_SCOPE' | 'RULE_PACK' | 'RULE_PACK_VERSION' | 'RULE_PACK_MEMBER' | 'PATIENT' | 'CLINICIAN_FACILITY_ASSIGNMENT' | 'CLINICIAN_SPECIALTY_ASSIGNMENT' | 'INSURANCE_MEMBERSHIP' | 'ENCOUNTER' | 'ENCOUNTER_DIAGNOSIS' | 'ENCOUNTER_ACTIVITY' | 'ENCOUNTER_OBSERVATION' | 'EVIDENCE_ARTIFACT' | 'EVIDENCE_ARTIFACT_VERSION' | 'ELIGIBILITY_VERIFICATION' | 'PRIOR_AUTHORIZATION' | 'PRIOR_AUTHORIZATION_VERSION' | 'AUTHORIZATION_LINE' | 'EVIDENCE_REQUIREMENT' | 'ENCOUNTER_EVIDENCE_LINK' | 'VALIDATION_RUN'

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
