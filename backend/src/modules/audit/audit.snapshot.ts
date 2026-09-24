import { deriveTargetFromRecord } from '../external-identifier/external-identifier.target.ts'

export const organizationAuditSnapshot = (x: { id: string; name: string }) => ({
  id: x.id,
  name: x.name,
})

export const facilityAuditSnapshot = (x: { id: string; organizationId: string; name: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  name: x.name,
})

export const clinicianAuditSnapshot = (x: { id: string; organizationId: string; displayName: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  displayName: x.displayName,
})

export const specialtyAuditSnapshot = (x: { id: string; organizationId: string; displayName: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  displayName: x.displayName,
})

export const payerAuditSnapshot = (x: { id: string; organizationId: string; displayName: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  displayName: x.displayName,
})

export const tpaAuditSnapshot = (x: { id: string; organizationId: string; displayName: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  displayName: x.displayName,
})

export const networkAuditSnapshot = (x: { id: string; organizationId: string; displayName: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  displayName: x.displayName,
})

export const serviceAuditSnapshot = (x: {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  internalCode: x.internalCode,
  displayName: x.displayName,
})

export const procedureCodeAuditSnapshot = (x: {
  id: string
  organizationId: string
  internalCode: string
  displayName: string
  codeSystem: string | null
  externalCode: string | null
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  internalCode: x.internalCode,
  displayName: x.displayName,
  codeSystem: x.codeSystem,
  externalCode: x.externalCode,
})

export const diagnosisCodeAuditSnapshot = (x: {
  id: string
  organizationId: string
  code: string
  displayName: string
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  code: x.code,
  displayName: x.displayName,
})

export const ruleSourceAuditSnapshot = (x: {
  id: string
  organizationId: string | null
  jurisdictionCode: string
  issuingAuthority: string
  sourceCategory: string
  referenceNumber: string
  title: string
  ownershipScope: string
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  jurisdictionCode: x.jurisdictionCode,
  issuingAuthority: x.issuingAuthority,
  sourceCategory: x.sourceCategory,
  referenceNumber: x.referenceNumber,
  title: x.title,
  ownershipScope: x.ownershipScope,
})

export const ruleSourceVersionAuditSnapshot = (x: {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  publicationStatus: string
  publicationDate: Date | null
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
  activationStatus: string
  activationBlockers: string[]
  activatedAt: Date | null
  everActivated: boolean
  firstActivatedAt: Date | null
  suspendedAt: Date | null
  supersededAt: Date | null
  retiredAt: Date | null
}) => ({
  id: x.id,
  sourceId: x.sourceId,
  version: x.version,
  rawEvidenceRef: x.rawEvidenceRef,
  publicationStatus: x.publicationStatus,
  publicationDate: x.publicationDate ? x.publicationDate.toISOString().slice(0, 10) : null,
  effectiveFrom: x.effectiveFrom ? x.effectiveFrom.toISOString().slice(0, 10) : null,
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
  verificationStatus: x.verificationStatus,
  verifiedAt: x.verifiedAt ? x.verifiedAt.toISOString() : null,
  activationStatus: x.activationStatus,
  activationBlockers: x.activationBlockers,
  activatedAt: x.activatedAt ? x.activatedAt.toISOString() : null,
  everActivated: x.everActivated,
  firstActivatedAt: x.firstActivatedAt ? x.firstActivatedAt.toISOString() : null,
  suspendedAt: x.suspendedAt ? x.suspendedAt.toISOString() : null,
  supersededAt: x.supersededAt ? x.supersededAt.toISOString() : null,
  retiredAt: x.retiredAt ? x.retiredAt.toISOString() : null,
})

export const sourceInterpretationAuditSnapshot = (x: {
  id: string
  sourceVersionId: string
  interpretationVersion: string
  normalizedInterpretationRef: string
  verificationStatus: string
  verifiedAt: Date | null
}) => ({
  id: x.id,
  sourceVersionId: x.sourceVersionId,
  interpretationVersion: x.interpretationVersion,
  normalizedInterpretationRef: x.normalizedInterpretationRef,
  verificationStatus: x.verificationStatus,
  verifiedAt: x.verifiedAt ? x.verifiedAt.toISOString() : null,
})

export const ruleSourceRelationshipAuditSnapshot = (x: {
  id: string
  fromSourceVersionId: string
  toSourceVersionId: string
  relationshipType: string
}) => ({
  id: x.id,
  fromSourceVersionId: x.fromSourceVersionId,
  toSourceVersionId: x.toSourceVersionId,
  relationshipType: x.relationshipType,
})

export const ruleDefinitionAuditSnapshot = (x: {
  id: string
  organizationId: string | null
  ruleKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  ruleKey: x.ruleKey,
  displayName: x.displayName,
  jurisdictionCode: x.jurisdictionCode,
  ownershipScope: x.ownershipScope,
})

export const ruleVersionAuditSnapshot = (x: {
  id: string
  ruleId: string
  version: string
  effectType: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
}) => ({
  id: x.id,
  ruleId: x.ruleId,
  version: x.version,
  effectType: x.effectType,
  effectiveFrom: x.effectiveFrom ? x.effectiveFrom.toISOString().slice(0, 10) : null,
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
  verificationStatus: x.verificationStatus,
  verifiedAt: x.verifiedAt ? x.verifiedAt.toISOString() : null,
})

export const ruleApplicabilityAuditSnapshot = (x: {
  id: string
  ruleVersionId: string
  facilityId: string | null
  facilityRegulatoryProfileId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
}) => ({
  id: x.id,
  ruleVersionId: x.ruleVersionId,
  facilityId: x.facilityId,
  facilityRegulatoryProfileId: x.facilityRegulatoryProfileId,
  payerId: x.payerId,
  tpaId: x.tpaId,
  networkId: x.networkId,
  insuranceProductId: x.insuranceProductId,
  providerContractId: x.providerContractId,
  tariffScheduleId: x.tariffScheduleId,
  tariffScheduleVersionId: x.tariffScheduleVersionId,
  serviceId: x.serviceId,
  procedureCodeId: x.procedureCodeId,
  diagnosisCodeId: x.diagnosisCodeId,
})

export const ruleSourceBindingAuditSnapshot = (x: {
  id: string
  ruleVersionId: string
  sourceInterpretationId: string
  sourceRole: string
}) => ({
  id: x.id,
  ruleVersionId: x.ruleVersionId,
  sourceInterpretationId: x.sourceInterpretationId,
  sourceRole: x.sourceRole,
})

export const facilityRegulatoryProfileAuditSnapshot = (x: {
  id: string
  facilityId: string
  jurisdictionCode: string
  regulatoryAuthorityCode: string
  effectiveFrom: Date
  effectiveTo: Date | null
  status: string
}) => ({
  id: x.id,
  facilityId: x.facilityId,
  jurisdictionCode: x.jurisdictionCode,
  regulatoryAuthorityCode: x.regulatoryAuthorityCode,
  effectiveFrom: x.effectiveFrom.toISOString().slice(0, 10),
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
  status: x.status,
})

export const insuranceProductAuditSnapshot = (x: {
  id: string
  organizationId: string
  payerId: string
  productCode: string
  displayName: string
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  payerId: x.payerId,
  productCode: x.productCode,
  displayName: x.displayName,
})

export const productNetworkAuditSnapshot = (x: { id: string; insuranceProductId: string; networkId: string }) => ({
  id: x.id,
  insuranceProductId: x.insuranceProductId,
  networkId: x.networkId,
})

export const providerContractAuditSnapshot = (x: {
  id: string
  organizationId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  contractKey: string
  displayName: string
  effectiveFrom: Date
  effectiveTo: Date | null
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  payerId: x.payerId,
  tpaId: x.tpaId,
  networkId: x.networkId,
  insuranceProductId: x.insuranceProductId,
  contractKey: x.contractKey,
  displayName: x.displayName,
  effectiveFrom: x.effectiveFrom.toISOString().slice(0, 10),
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
})

export const contractFacilityAuditSnapshot = (x: { id: string; providerContractId: string; facilityId: string }) => ({
  id: x.id,
  providerContractId: x.providerContractId,
  facilityId: x.facilityId,
})

export const tariffScheduleAuditSnapshot = (x: {
  id: string
  providerContractId: string
  tariffKey: string
  displayName: string
}) => ({
  id: x.id,
  providerContractId: x.providerContractId,
  tariffKey: x.tariffKey,
  displayName: x.displayName,
})

export const tariffScheduleVersionAuditSnapshot = (x: {
  id: string
  tariffScheduleId: string
  version: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
}) => ({
  id: x.id,
  tariffScheduleId: x.tariffScheduleId,
  version: x.version,
  effectiveFrom: x.effectiveFrom ? x.effectiveFrom.toISOString().slice(0, 10) : null,
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
  verificationStatus: x.verificationStatus,
  verifiedAt: x.verifiedAt ? x.verifiedAt.toISOString() : null,
})

export const ruleSourceScopeAuditSnapshot = (x: {
  id: string
  sourceId: string
  facilityId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
}) => ({
  id: x.id,
  sourceId: x.sourceId,
  facilityId: x.facilityId,
  payerId: x.payerId,
  tpaId: x.tpaId,
  networkId: x.networkId,
  insuranceProductId: x.insuranceProductId,
  providerContractId: x.providerContractId,
  tariffScheduleId: x.tariffScheduleId,
  tariffScheduleVersionId: x.tariffScheduleVersionId,
})

export const externalIdentifierAuditSnapshot = (x: {
  id: string
  organizationId: string
  sourceSystem: string
  externalValue: string
  organizationTargetId: string | null
  facilityId: string | null
  clinicianId: string | null
  specialtyId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
}) => {
  const target = deriveTargetFromRecord(x)
  return {
    id: x.id,
    organizationId: x.organizationId,
    sourceSystem: x.sourceSystem,
    externalValue: x.externalValue,
    targetType: target.type,
    targetId: target.id,
  }
}

// A3.9 — rule pack audit snapshots.
export const rulePackAuditSnapshot = (x: {
  id: string
  organizationId: string | null
  packKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
}) => ({
  id: x.id,
  organizationId: x.organizationId,
  packKey: x.packKey,
  displayName: x.displayName,
  jurisdictionCode: x.jurisdictionCode,
  ownershipScope: x.ownershipScope,
})

export const rulePackVersionAuditSnapshot = (x: {
  id: string
  rulePackId: string
  version: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
  activationStatus: string
  activatedAt: Date | null
  supersededAt: Date | null
}) => ({
  id: x.id,
  rulePackId: x.rulePackId,
  version: x.version,
  effectiveFrom: x.effectiveFrom ? x.effectiveFrom.toISOString().slice(0, 10) : null,
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
  verificationStatus: x.verificationStatus,
  verifiedAt: x.verifiedAt ? x.verifiedAt.toISOString() : null,
  activationStatus: x.activationStatus,
  activatedAt: x.activatedAt ? x.activatedAt.toISOString() : null,
  supersededAt: x.supersededAt ? x.supersededAt.toISOString() : null,
})

export const rulePackMemberAuditSnapshot = (x: { id: string; rulePackVersionId: string; ruleVersionId: string }) => ({
  id: x.id,
  rulePackVersionId: x.rulePackVersionId,
  ruleVersionId: x.ruleVersionId,
})

// A4.1 §12 — the PHI boundary. A patient AuditEvent records only safe metadata: which row, which
// tenant, when it changed and (on update) WHICH fields changed. Names, dates of birth, phone
// numbers, e-mail addresses and the request body are deliberately absent, because business audit
// must stay useful without becoming a second store of patient-identifying data.
export const patientAuditSnapshot = (x: { id: string; organizationId: string; updatedAt: Date }, changedFields?: string[]) => ({
  id: x.id,
  organizationId: x.organizationId,
  updatedAt: x.updatedAt.toISOString(),
  ...(changedFields ? { changedFields: [...changedFields].sort() } : {}),
})

// A4.2 §16 — assignment audit is bounded to identifiers and dates. Clinician, facility and
// specialty display names, and any external licence value, stay with their own owners and are
// never duplicated into AuditEvent.
export const clinicianAssignmentAuditSnapshot = (x: {
  id: string
  clinicianId: string
  targetField: 'facilityId' | 'specialtyId'
  targetId: string
  effectiveFrom: Date
  effectiveTo: Date | null
}) => ({
  id: x.id,
  clinicianId: x.clinicianId,
  [x.targetField]: x.targetId,
  effectiveFrom: x.effectiveFrom.toISOString().slice(0, 10),
  effectiveTo: x.effectiveTo ? x.effectiveTo.toISOString().slice(0, 10) : null,
})

// A4.3 §14 — the sensitive-identifier boundary. Member and policy identifiers are insurance card
// data: the audit records WHICH membership and commercial context changed, and on update WHICH
// fields changed, but never a member/policy value, a patient demographic or the request body. So a
// changed memberIdentifier appears only as the name 'memberIdentifier' in changedFields.
export const insuranceMembershipAuditSnapshot = (
  x: {
    id: string
    patientId: string
    payerId: string
    tpaId: string | null
    networkId: string | null
    insuranceProductId: string | null
    coverageFrom: Date | null
    coverageTo: Date | null
    updatedAt: Date
  },
  changedFields?: string[],
) => ({
  id: x.id,
  patientId: x.patientId,
  payerId: x.payerId,
  tpaId: x.tpaId,
  networkId: x.networkId,
  insuranceProductId: x.insuranceProductId,
  coverageFrom: x.coverageFrom ? x.coverageFrom.toISOString().slice(0, 10) : null,
  coverageTo: x.coverageTo ? x.coverageTo.toISOString().slice(0, 10) : null,
  updatedAt: x.updatedAt.toISOString(),
  ...(changedFields ? { changedFields: [...changedFields].sort() } : {}),
})
