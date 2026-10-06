import type { ReadinessState } from './pre-claim-readiness.types.ts'

// A5.9 §3/§4 — the A5-READY-1 policy as pure functions. No database, no clock, no message text and no
// finding code: the state is decided by outcomes alone.

// §4 — compatibility is named per readiness policy, never assumed. A future validator contract is not
// accepted until a policy lists it explicitly.
const compatibleValidatorVersions: Readonly<Record<string, readonly string[]>> = {
  'A5-READY-1': ['A5-VAL-1'],
}

export function isValidatorCompatible(readinessPolicyVersion: string, validatorVersion: string): boolean {
  return Object.hasOwn(compatibleValidatorVersions, readinessPolicyVersion) && compatibleValidatorVersions[readinessPolicyVersion].includes(validatorVersion)
}

const knownOutcomes: ReadonlySet<string> = new Set(['PASS', 'WARNING', 'RESTRICT', 'FAIL'])

// §3 — FAIL > RESTRICT > WARNING/PASS. Returns null for an empty set or an outcome outside the A5.7
// vocabulary, so the caller fails closed instead of guessing a state.
export function reduceReadiness(outcomes: readonly string[]): ReadinessState | null {
  if (outcomes.length === 0 || outcomes.some((outcome) => !knownOutcomes.has(outcome))) return null
  if (outcomes.includes('FAIL')) return 'BLOCKED'
  if (outcomes.includes('RESTRICT')) return 'RESTRICTED'
  return 'READY_FOR_REVIEW'
}

// §11 — whether a later validation of the same Encounter exists, on the order key (evaluatedAt,
// createdAt). The comparisons themselves are made by the database at full microsecond precision (a
// JavaScript Date keeps only milliseconds and would invent ties). Another run at exactly the same pair
// cannot be ordered, so it is ambiguous. The run id, finding count, outcome and creator are never a
// tie-break, and a newer run supersedes whatever its own readiness turns out to be.
export function decideRecency(relations: { anyNewer: boolean; anyTied: boolean }): 'LATEST' | 'SUPERSEDED' | 'AMBIGUOUS' {
  if (relations.anyNewer) return 'SUPERSEDED'
  return relations.anyTied ? 'AMBIGUOUS' : 'LATEST'
}
