// The editable coverage form state. An empty string means "Not recorded".
export type CoverageDraft = {
  payerId: string
  tpaId: string
  networkId: string
  insuranceProductId: string
  memberIdentifier: string
  policyIdentifier: string
  coverageFrom: string
  coverageTo: string
}

export const emptyCoverageDraft: CoverageDraft = {
  payerId: '',
  tpaId: '',
  networkId: '',
  insuranceProductId: '',
  memberIdentifier: '',
  policyIdentifier: '',
  coverageFrom: '',
  coverageTo: '',
}
