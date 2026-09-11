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
