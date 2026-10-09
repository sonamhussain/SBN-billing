// FE-04 — the A5.7 ValidationRun/Finding read contract and the A5.8 execute result. Runs are immutable
// history with no "current" pointer; findings keep the backend's layer, outcome, code and safe message.
// The frontend never generates, edits, merges or interprets findings.
export const findingLayers = ['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE'] as const

export type ValidationRun = {
  id: string
  encounterId: string
  evaluatedAt: string
  validatorVersion: string
  createdAt: string
  findingCount: number
}

export type ValidationFinding = {
  id: string
  validationRunId: string
  sequence: number
  layer: string
  outcome: string
  findingCode: string
  fieldPath: string | null
  message: string
  provenance: Record<string, string | null>
  ruleProvenance: {
    provenanceContractVersion: string
    precedencePolicyVersion: string
    rulePackVersionId: string | null
    governingBindingId: string
    governingSourceInterpretationId: string
    businessDate: string
    evaluationTimestamp: string
    historicalOnly: boolean
  } | null
}

export type ValidationExecution = {
  validationRunId: string
  evaluatedAt: string
  validatorVersion: string
  findingCount: number
}
