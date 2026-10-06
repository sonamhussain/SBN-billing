import { apiRequest } from '../../shared/api/client.ts'
import type { InsuranceMembership, InsuranceMembershipCreateInput, InsuranceMembershipPatch } from './insurance-membership.types.ts'

// FE-02 — real A4.3 endpoints only. Member and policy identifiers travel in request bodies, never in
// a URL or query string.

export function listMemberships(patientId: string) {
  return apiRequest<{ items: InsuranceMembership[] }>(`/api/patients/${patientId}/insurance-memberships`)
}

export function createMembership(patientId: string, input: InsuranceMembershipCreateInput) {
  return apiRequest<InsuranceMembership>(`/api/patients/${patientId}/insurance-memberships`, { method: 'POST', body: JSON.stringify(input) })
}

export function updateMembership(membershipId: string, patch: InsuranceMembershipPatch) {
  return apiRequest<InsuranceMembership>(`/api/insurance-memberships/${membershipId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}
