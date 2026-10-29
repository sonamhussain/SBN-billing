import { ADMISSIBLE_REASONS, type ExceptionReasonCode, type OwnerVerdict } from './exception-intake.types.ts'

// A8.1 §3/§5 — the one pure rule that says which reasons an owner's own verdict establishes for one exact source. A
// caller's assertion alone never establishes anything: a reason is admissible only when its owner answered with the
// one verdict mapped to it. An unexpected or future verdict establishes nothing (fail closed). It never reads a
// clock, database, network or locale, and never interprets an owner's message text.
//
//   REVENUE_TIMELINE: the A7.7 owner refused the Claim's history          -> PROVENANCE_CONFLICT
//   CLOSURE_PREREQUISITE_ASSESSMENT: the A7.6 owner refused the trace     -> HISTORICAL_RECORD_INCONSISTENT
//   CLOSURE_PREREQUISITE_ASSESSMENT: the stored outcome is REVIEW_REQUIRED -> OPERATOR_REVIEW_REQUIRED
// A stored EXTERNAL_FINANCIAL_EVIDENCE_ABSENT (or any other normal outcome) establishes nothing.

export function establishedReasons(verdict: OwnerVerdict): ExceptionReasonCode[] {
  const established: ExceptionReasonCode[] = []
  if (verdict.kind === 'REVENUE_TIMELINE') {
    if (verdict.timelineCode === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT') established.push('PROVENANCE_CONFLICT')
  } else if (verdict.kind === 'CLOSURE_PREREQUISITE_ASSESSMENT') {
    if (verdict.traceCode === 'CLOSURE_BASIS_PROVENANCE_CONFLICT') established.push('HISTORICAL_RECORD_INCONSISTENT')
    if (verdict.assessmentCode === 'REVIEW_REQUIRED') established.push('OPERATOR_REVIEW_REQUIRED')
  }
  return established.filter((reason) => ADMISSIBLE_REASONS[verdict.kind].includes(reason))
}
