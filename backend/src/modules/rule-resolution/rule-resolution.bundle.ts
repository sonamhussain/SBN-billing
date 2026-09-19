import type { ApplicabilityContextV2 } from '../../shared/rules/applicability-context-v2.ts'
import type { RuleResolutionDto, RuleResolutionEvaluationBundle } from './rule-resolution.types.ts'

// A3.9 v1.2 — why a registry and not just a type. A TypeScript type cannot stop a caller from
// splicing `{ ...bundleA, authoritativeContext: bundleB.authoritativeContext }`, and that spliced
// object would still satisfy the type. So:
// - every bundle is deep-frozen, and a private copy of exactly what the evaluation produced is
//   kept in a module-private WeakMap keyed by the bundle object itself;
// - the consumer reads that private copy, never the object's own fields — a spliced object is a
//   different object with no entry, so it is refused, and mutating an issued bundle (for example
//   evaluationTimestamp.setTime(), which freezing cannot prevent on a Date) changes nothing;
// - exactly one issuer exists and it is handed out once, to the A3.8 resolution service at
//   module load; nothing else can mint a trusted bundle.
// This is plain in-process bookkeeping: no row, no audit, no new resolver.

type IssuedEvaluation = {
  resolution: RuleResolutionDto
  authoritativeContext: ApplicabilityContextV2
  organizationId: string
  evaluationTimestampMs: number
}

export type TrustedEvaluation = {
  resolution: RuleResolutionDto
  authoritativeContext: ApplicabilityContextV2
  organizationId: string
  evaluationTimestamp: Date
}

const issued = new WeakMap<object, IssuedEvaluation>()

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function issueEvaluationBundle(parts: TrustedEvaluation): RuleResolutionEvaluationBundle {
  const record: IssuedEvaluation = {
    resolution: structuredClone(parts.resolution),
    authoritativeContext: structuredClone(parts.authoritativeContext),
    organizationId: parts.organizationId,
    evaluationTimestampMs: parts.evaluationTimestamp.getTime(),
  }
  const bundle = deepFreeze({
    resolution: structuredClone(parts.resolution),
    authoritativeContext: structuredClone(parts.authoritativeContext),
    organizationId: parts.organizationId,
    evaluationTimestamp: new Date(record.evaluationTimestampMs),
  })
  issued.set(bundle, record)
  return bundle
}

let issuerTaken = false

// Called exactly once, by rule-resolution.service.ts. A second caller is a programming error.
export function takeEvaluationBundleIssuer(): typeof issueEvaluationBundle {
  if (issuerTaken) throw new Error('rule resolution: the evaluation bundle issuer has already been taken by the A3.8 resolver')
  issuerTaken = true
  return issueEvaluationBundle
}

// The composer's only way in: the exact evaluation behind an issued bundle, as fresh copies, or
// null for anything the A3.8 resolver did not issue.
export function readIssuedEvaluation(bundle: unknown): TrustedEvaluation | null {
  if (!bundle || typeof bundle !== 'object') return null
  const record = issued.get(bundle)
  if (!record) return null
  return {
    resolution: structuredClone(record.resolution),
    authoritativeContext: structuredClone(record.authoritativeContext),
    organizationId: record.organizationId,
    evaluationTimestamp: new Date(record.evaluationTimestampMs),
  }
}
