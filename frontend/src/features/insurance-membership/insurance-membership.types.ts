// FE-02 — the A4.3 InsuranceMembership contract. It is recorded registration truth only: nothing here
// says a membership is active, eligible, verified, primary or authorized.
export type InsuranceMembership = {
  id: string
  patientId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  memberIdentifier: string
  policyIdentifier: string | null
  coverageFrom: string | null
  coverageTo: string | null
  createdAt: string
  updatedAt: string
}

export type InsuranceMembershipCreateInput = {
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  memberIdentifier: string
  policyIdentifier: string | null
  coverageFrom: string | null
  coverageTo: string | null
}

export type InsuranceMembershipPatch = Partial<InsuranceMembershipCreateInput>
