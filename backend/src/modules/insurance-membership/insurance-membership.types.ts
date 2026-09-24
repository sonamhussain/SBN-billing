// A4.3 — InsuranceMembership answers one question: "what insurance membership did we record for
// this patient?" — which payer (and, when known, which TPA, network and product), which member and
// policy identifiers, and which coverage dates were recorded. It is registration truth, never
// eligibility: it does not say that coverage is verified today, that a service is covered, that an
// authorization exists or what a payer will reimburse. Those evidence-bearing answers begin in A5.

export type InsuranceMembershipDto = {
  id: string
  patientId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  // Operational registration data for an authorized caller only; never logged or audited.
  memberIdentifier: string
  policyIdentifier: string | null
  // Recorded calendar dates (YYYY-MM-DD) or null when unknown — never an "active" claim.
  coverageFrom: string | null
  coverageTo: string | null
  createdAt: string
  updatedAt: string
}

export type InsuranceMembershipErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type InsuranceMembershipResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: InsuranceMembershipErrorCode; message: string }

// The only fields a client may supply. patientId comes from the route; id/createdAt/updatedAt are
// server-owned. Supplying any of those is rejected, never silently ignored.
export const membershipWritableFields = [
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'memberIdentifier',
  'policyIdentifier',
  'coverageFrom',
  'coverageTo',
] as const
export type MembershipWritableField = (typeof membershipWritableFields)[number]

export const membershipImmutableFields = ['id', 'patientId', 'createdAt', 'updatedAt'] as const
