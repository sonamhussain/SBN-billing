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
