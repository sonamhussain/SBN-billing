export const organizationAuditSnapshot = (x: { id: string; name: string }) => ({
  id: x.id,
  name: x.name,
})

export const facilityAuditSnapshot = (x: { id: string; organizationId: string; name: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  name: x.name,
})
