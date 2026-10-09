import { Badge } from './Badge.tsx'

// FE-04 — visual styling for a value the backend already decided (a finding outcome, readiness state,
// completeness state, eligibility status or freshness). It only picks a colour for the value it is
// given; it never computes, combines or re-labels a business outcome. Unknown values stay neutral.
type Tone = 'neutral' | 'success' | 'attention' | 'danger'

const tones: Record<string, Tone> = {
  PASS: 'success',
  WARNING: 'attention',
  RESTRICT: 'attention',
  FAIL: 'danger',
  READY_FOR_REVIEW: 'success',
  RESTRICTED: 'attention',
  BLOCKED: 'danger',
  SATISFIED: 'success',
  INCOMPLETE: 'attention',
  MISSING: 'danger',
  ELIGIBLE: 'success',
  INELIGIBLE: 'danger',
  FRESH: 'success',
  STALE: 'attention',
  MATCHED: 'success',
}

export function OutcomeBadge({ value, label }: { value: string; label?: string }) {
  return <Badge tone={tones[value] ?? 'neutral'}>{label ?? value}</Badge>
}
