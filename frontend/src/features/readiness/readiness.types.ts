// FE-04 — the A5.9 readiness contract. An assessment belongs to one exact ValidationRun and is derived by
// the server under A5-READY-1; the client sends no state, policy or counts. READY_FOR_REVIEW means human
// claim review may begin — never approved, ready to submit or accepted by a payer.
export type ReadinessAssessment = {
  id: string
  validationRunId: string
  readinessPolicyVersion: string
  state: string
  assessedAt: string
  createdAt: string
}

export type ReadinessReasonRef = { findingId: string; sequence: number; findingCode: string }

export type ReadinessAssessmentDetail = ReadinessAssessment & {
  reasons: {
    blockedFindings: ReadinessReasonRef[]
    restrictedFindings: ReadinessReasonRef[]
    warningFindings: ReadinessReasonRef[]
    passFindings: ReadinessReasonRef[]
  }
}

// The exact pre-claim handoff for a READY_FOR_REVIEW assessment: references and counts only. There is no
// claim, claim line, price, approver, payload or transmission in it.
export type PreClaimA6Handoff = {
  schemaVersion: 'PreClaimA6HandoffV1'
  readinessAssessmentId: string
  readinessPolicyVersion: string
  readinessState: 'READY_FOR_REVIEW'
  assessedAt: string
  validationRun: { id: string; validatorVersion: string; evaluatedAt: string; encounterId: string }
  findingSummary: { total: number; pass: number; warning: number; restrict: number; fail: number }
  findingRefs: { id: string; sequence: number; layer: string; outcome: string; findingCode: string }[]
  exactReferences: Record<string, string[]>
}
