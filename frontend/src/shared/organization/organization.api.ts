import { apiRequest } from '../api/client.ts'

// FE-02 — the access proof and the organization record, both read through the FE-01 HTTP boundary.

export type AccessProof = {
  organizationId: string
  membershipId: string
  permissions: string[]
}

export type Organization = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export function getOrganizationAccess(organizationId: string) {
  return apiRequest<AccessProof>(`/api/access/organizations/${organizationId}`)
}

export function getOrganization(organizationId: string) {
  return apiRequest<Organization>(`/api/organizations/${organizationId}`)
}
