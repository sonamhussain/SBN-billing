import type { EvidenceCandidateState, RequirementState } from './evidence-requirement.types.ts'

// A5.6 §12–§13 — candidate classification and requirement completeness. Pure: every fact is passed
// in, so the whole judgement is unit-testable and there is exactly one copy of it.
//
// Nothing here parses evidence, infers validity from a storage reference or hash, or reads the wall
// clock. Freshness is anchored to the Encounter's service date.

export type PoolEvidence = {
  // An exact A5.1 EvidenceArtifactVersion id.
  id: string
  documentType: string
  sourceDate: Date | null
}

export type RequirementSpec = {
  acceptedDocumentTypes: readonly string[]
  minimumCount: number
  sourceDateRequired: boolean
  maxSourceAgeDays: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const sortIds = (ids: string[]) => [...ids].sort()

// Calendar days, on UTC-midnight dates: serviceDate minus maxSourceAgeDays.
export function freshnessThreshold(serviceDate: Date, maxSourceAgeDays: number): Date {
  return new Date(serviceDate.getTime() - maxSourceAgeDays * DAY_MS)
}

export function classifyCandidate(evidence: PoolEvidence, spec: RequirementSpec, serviceDate: Date): EvidenceCandidateState {
  if (spec.sourceDateRequired && evidence.sourceDate === null) return 'INVALID'
  // Inclusive: a source date exactly maxSourceAgeDays before the service date is still fresh. A
  // source date after the service date is never made stale by an age rule.
  if (evidence.sourceDate !== null && spec.maxSourceAgeDays !== null && evidence.sourceDate.getTime() < freshnessThreshold(serviceDate, spec.maxSourceAgeDays).getTime())
    return 'STALE'
  return 'VALID'
}

export type RequirementCompleteness = {
  state: RequirementState
  validCount: number
  invalidCount: number
  staleCount: number
  totalCandidateCount: number
  validEvidenceArtifactVersionIds: string[]
  invalidEvidenceArtifactVersionIds: string[]
  staleEvidenceArtifactVersionIds: string[]
}

export function evaluateRequirement(spec: RequirementSpec, pool: PoolEvidence[], serviceDate: Date): RequirementCompleteness {
  // One exact version counts once, however many paths referenced it.
  const distinct = new Map<string, PoolEvidence>()
  for (const evidence of pool) if (!distinct.has(evidence.id)) distinct.set(evidence.id, evidence)

  // Exact, case-sensitive: the label is opaque, never upper- or lower-cased.
  const accepted = new Set(spec.acceptedDocumentTypes)
  const valid: string[] = []
  const invalid: string[] = []
  const stale: string[] = []
  for (const evidence of distinct.values()) {
    if (!accepted.has(evidence.documentType)) continue
    const state = classifyCandidate(evidence, spec, serviceDate)
    if (state === 'VALID') valid.push(evidence.id)
    else if (state === 'INVALID') invalid.push(evidence.id)
    else stale.push(evidence.id)
  }

  const totalCandidateCount = valid.length + invalid.length + stale.length
  // Defects are counted, never ranked: INVALID and STALE stay separate, and a satisfied requirement
  // still reports the defective candidates beside it.
  const state: RequirementState = totalCandidateCount === 0 ? 'MISSING' : valid.length >= spec.minimumCount ? 'SATISFIED' : 'INCOMPLETE'
  return {
    state,
    validCount: valid.length,
    invalidCount: invalid.length,
    staleCount: stale.length,
    totalCandidateCount,
    validEvidenceArtifactVersionIds: sortIds(valid),
    invalidEvidenceArtifactVersionIds: sortIds(invalid),
    staleEvidenceArtifactVersionIds: sortIds(stale),
  }
}
