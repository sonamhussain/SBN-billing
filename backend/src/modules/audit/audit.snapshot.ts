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
