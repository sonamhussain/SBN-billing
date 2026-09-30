// A5.4 — an AuthorizationLine is one line of line-level authorization scope, as reported for one exact
// A5.3 PriorAuthorizationVersion: which service and/or procedure, an optional diagnosis, the requested
// and approved quantities, an optional unit, optional approved dates, and the reported line status.
//
// Lines are captured once per version as a single ordered batch and never edited. A payer amendment
// or correction is a new A5.3 version with a new line set, so the scope a decision was made against
// can always be reconstructed.
//
// A5.4 also compares that scope with the Encounter as it stands now — read-only, in one snapshot,
// every time it is asked. It reports deterministic scope facts only. It never decides that an
// authorization is satisfied, that a claim is ready, or that a payer will accept anything.

// Exactly the six A5.3 statuses, recorded as reported. ACTIVE, EXPIRED, current and satisfied are
// derived states and are deliberately absent.
export const lineStatuses = ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'] as const
export type LineStatus = (typeof lineStatuses)[number]

// Statuses that permit further scope evaluation. Both the A5.3 header and the line must be one of
// these; neither is inferred from the other.
export const approvingStatuses = ['APPROVED', 'PARTIALLY_APPROVED'] as const

// A synthetic safety cap on one batch.
export const MAX_LINES_PER_BATCH = 200

export type AuthorizationLineInput = {
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  // Exact decimal strings, carried as strings so no binary floating point ever touches them.
  requestedQty: string
  approvedQty: string | null
  unitCode: string | null
  approvedFrom: Date | null
  approvedThrough: Date | null
  status: LineStatus
}

export type AuthorizationLineDto = {
  id: string
  priorAuthorizationVersionId: string
  // 1..N in submitted order. Display and source order only — never precedence.
  sequence: number
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  requestedQty: string
  approvedQty: string | null
  unitCode: string | null
  approvedFrom: string | null
  approvedThrough: string | null
  status: LineStatus
  createdByUserId: string
  createdAt: string
}

export type AuthorizationLineListDto = { items: AuthorizationLineDto[] }

export type AuthorizationLineErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR'

export type AuthorizationLineResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AuthorizationLineErrorCode; message: string }

// The only fields a caller may supply on one line.
export const lineInputFields = [
  'serviceId',
  'procedureCodeId',
  'diagnosisCodeId',
  'requestedQty',
  'approvedQty',
  'unitCode',
  'approvedFrom',
  'approvedThrough',
  'status',
] as const

// Refused by name rather than ignored. The last three would let a caller bake a match result into the
// source scope, which would go stale the moment the Encounter changed.
export const lineServerOwnedFields = [
  'id',
  'sequence',
  'priorAuthorizationVersionId',
  'createdByUserId',
  'createdAt',
  'matchedActivityId',
  'claimLineId',
  'matchOutcome',
] as const

// ---- ScopeEvaluationV1 ---------------------------------------------------------------------------

// Deterministic scope facts, not claim lifecycle states and not validation findings. A5.8 may
// translate them into governed findings with provenance; A5.4 only reports them.
export const scopeOutcomes = [
  'MATCHED',
  'NO_MATCH',
  'AMBIGUOUS',
  'CONTEXT_MISMATCH',
  'HEADER_STATUS_NOT_APPROVED',
  'LINE_STATUS_NOT_APPROVED',
  'DATE_OUTSIDE_SCOPE',
  'UNIT_MISMATCH',
  'QUANTITY_UNKNOWN',
  'QUANTITY_EXCEEDED',
] as const
export type AuthorizationScopeOutcome = (typeof scopeOutcomes)[number]

export type QuantityOutcome = 'WITHIN' | 'EXCEEDED' | 'UNKNOWN'

export type ActivityScopeDto = {
  encounterActivityId: string
  outcome: AuthorizationScopeOutcome
  // The single candidate line when there was exactly one, whatever the outcome; null when there was
  // none, several, or the context no longer matched.
  authorizationLineId: string | null
  // Every candidate, in ascending id order. Never ranked.
  candidateAuthorizationLineIds: string[]
}

export type LineUtilizationDto = {
  authorizationLineId: string
  matchedActivityIds: string[]
  matchedQty: string
  approvedQty: string | null
  quantityOutcome: QuantityOutcome
}

export type AuthorizationScopeEvaluationV1 = {
  schemaVersion: 'AuthorizationScopeEvaluationV1'
  evaluatedAt: string
  priorAuthorizationId: string
  priorAuthorizationVersionId: string
  encounterId: string
  contextMatch: boolean
  activities: ActivityScopeDto[]
  lineUtilization: LineUtilizationDto[]
}
